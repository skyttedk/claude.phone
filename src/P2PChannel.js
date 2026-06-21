/**
 * P2PChannel - Serverless WebRTC data channel over node-datachannel.
 *
 * No signaling server, no broker. NAT traversal via Google STUN only.
 * The SDP offer/answer handshake is exchanged out-of-band (copy-paste between
 * sessions), so trickle ICE is DISABLED: we wait for ICE gathering to finish
 * and emit one self-contained, base64-encoded description blob per step.
 *
 * Inspired by fortea.game.engine/src/systems/network/P2PConnection.js (PeerJS),
 * but reimplemented broker-free for Node so two AI-agent sessions on different
 * machines can talk directly.
 *
 * Handshake:
 *   Initiator:  createOffer()   -> offerBlob   --copy-->
 *   Responder:  acceptOffer(offerBlob) -> answerBlob  <--copy--
 *   Initiator:  acceptAnswer(answerBlob) -> connected
 */
'use strict';

const ndc = require('node-datachannel');

// Google STUN servers (mirrors Fortea's iceServers list). STUN only does NAT
// traversal — it never relays data. Behind symmetric NAT a TURN server would
// be required; none is configured here to keep this fully serverless.
const STUN_SERVERS = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
];

const ICE_GATHER_TIMEOUT_MS = 15000;

function encodeDescription(desc) {
    // desc = { type: 'offer'|'answer', sdp: '...' }
    return Buffer.from(JSON.stringify(desc), 'utf8').toString('base64');
}

function decodeDescription(blob) {
    const trimmed = String(blob).trim();
    const json = Buffer.from(trimmed, 'base64').toString('utf8');
    const desc = JSON.parse(json);
    if (!desc || !desc.type || !desc.sdp) {
        throw new Error('Invalid handshake blob: missing type/sdp after decode');
    }
    return desc;
}

class P2PChannel {
    /**
     * @param {object} [opts]
     * @param {string} [opts.label] - DataChannel label.
     * @param {(msg: string) => void} [opts.onMessage] - Incoming message callback.
     * @param {(state: string) => void} [opts.onStateChange] - Connection state callback.
     */
    constructor(opts = {}) {
        this.label = opts.label || 'claude-phone';
        this.onMessage = opts.onMessage || (() => {});
        this.onStateChange = opts.onStateChange || (() => {});

        this.pc = null;
        this.dc = null;
        this.role = null;            // 'initiator' | 'responder'
        this.connectionState = 'new';
        this.localPeerName = opts.peerName || null;
        this.remotePeerName = null;
        this.disposed = false;

        this.stats = { sent: 0, received: 0, bytesIn: 0, bytesOut: 0 };
    }

    isOpen() {
        return !!this.dc && this.dc.isOpen && this.dc.isOpen();
    }

    getState() {
        return {
            role: this.role,
            connectionState: this.connectionState,
            open: this.isOpen(),
            localPeerName: this.localPeerName,
            remotePeerName: this.remotePeerName,
            stats: { ...this.stats },
        };
    }

    _newPeerConnection() {
        const pc = new ndc.PeerConnection(this.label, {
            iceServers: STUN_SERVERS,
            // disableAutoNegotiation kept default; we drive negotiation manually.
        });

        pc.onStateChange((state) => {
            this.connectionState = state;
            this.onStateChange(state);
        });

        return pc;
    }

    _wireDataChannel(dc) {
        this.dc = dc;

        dc.onOpen(() => {
            this.onStateChange('channel-open');
        });

        dc.onMessage((msg) => {
            const text = typeof msg === 'string' ? msg : String(msg);
            this.stats.received++;
            this.stats.bytesIn += Buffer.byteLength(text, 'utf8');
            this.onMessage(text);
        });

        dc.onClosed(() => {
            this.onStateChange('channel-closed');
        });

        dc.onError((err) => {
            this.onStateChange('channel-error:' + err);
        });
    }

    /**
     * Wait until ICE gathering completes, then return the full local
     * description (offer or answer) with all candidates baked in.
     * @returns {Promise<{type:string, sdp:string}>}
     */
    _waitForLocalDescription() {
        return new Promise((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('ICE gathering timed out after ' + ICE_GATHER_TIMEOUT_MS + 'ms'));
            }, ICE_GATHER_TIMEOUT_MS);

            this.pc.onGatheringStateChange((state) => {
                if (state !== 'complete' || settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    const desc = this.pc.localDescription();
                    if (!desc || !desc.sdp) {
                        reject(new Error('No local description after ICE gathering'));
                        return;
                    }
                    resolve({ type: desc.type, sdp: desc.sdp });
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Initiator step 1: create the connection + data channel and produce an
     * offer blob to hand to the remote peer.
     * @returns {Promise<string>} base64 offer blob
     */
    async createOffer() {
        if (this.pc) throw new Error('Channel already initialized');
        this.role = 'initiator';
        this.pc = this._newPeerConnection();

        // Creating the data channel triggers offer generation.
        const dc = this.pc.createDataChannel(this.label);
        this._wireDataChannel(dc);

        const desc = await this._waitForLocalDescription();
        return encodeDescription(desc);
    }

    /**
     * Responder: consume the initiator's offer blob and produce an answer blob.
     * @param {string} offerBlob base64 offer from initiator
     * @returns {Promise<string>} base64 answer blob
     */
    async acceptOffer(offerBlob) {
        if (this.pc) throw new Error('Channel already initialized');
        this.role = 'responder';
        const offer = decodeDescription(offerBlob);
        if (offer.type !== 'offer') {
            throw new Error('Expected an offer blob, got: ' + offer.type);
        }

        this.pc = this._newPeerConnection();

        // Incoming data channel from the initiator.
        this.pc.onDataChannel((dc) => {
            this._wireDataChannel(dc);
        });

        this.pc.setRemoteDescription(offer.sdp, 'offer');
        // node-datachannel auto-creates the answer once remote offer is set.
        const desc = await this._waitForLocalDescription();
        return encodeDescription(desc);
    }

    /**
     * Initiator step 2: consume the responder's answer blob to finish the
     * handshake. The data channel opens shortly after.
     * @param {string} answerBlob base64 answer from responder
     */
    acceptAnswer(answerBlob) {
        if (this.role !== 'initiator') {
            throw new Error('acceptAnswer is only valid for the initiator');
        }
        const answer = decodeDescription(answerBlob);
        if (answer.type !== 'answer') {
            throw new Error('Expected an answer blob, got: ' + answer.type);
        }
        this.pc.setRemoteDescription(answer.sdp, 'answer');
    }

    /**
     * Send a text message over the open data channel.
     * @param {string} text
     */
    send(text) {
        if (!this.isOpen()) {
            throw new Error('Data channel not open (state: ' + this.connectionState + ')');
        }
        const payload = String(text);
        this.dc.sendMessage(payload);
        this.stats.sent++;
        this.stats.bytesOut += Buffer.byteLength(payload, 'utf8');
    }

    /** Tear down the connection and free native resources. */
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        try { if (this.dc) this.dc.close(); } catch (_) {}
        try { if (this.pc) this.pc.close(); } catch (_) {}
        this.dc = null;
        this.pc = null;
    }
}

module.exports = { P2PChannel, encodeDescription, decodeDescription, STUN_SERVERS };
