import adapter from 'src/AnalyticsAdapter';
import CONSTANTS from 'src/constants.json';
import * as adaptermanager from 'src/adaptermanager';
import {parse} from "../src/url";
import {ajax} from "../src/ajax"

const utils = require('src/utils');

let parser = parse(window.location);

let customHost = parser.search['pa_host'];
let host = parser.host;

const options = {
// TODO analyticHost must be changeable.
    analyticHost: customHost || '//pa.rxthdr.com/api/v2/',
    // TODO extract only host without www
    currentHost: host,
    adUnits: [],
    iUrl: '/i',
    aUrl: '/a',
    bUrl: '/b',
    prefix: 'roxot_analytics_',
    publisherId: null
};

/**
 * 1. UTM
 * 2. SessionId
 * 3. AdUnits
 * 4. PublisherId
 * 5. Content-type
 */


let roxotAdapter = Object.assign(adapter({analyticsType: 'endpoint'}), new RoxotAnalyticAdapter);

adaptermanager.registerAnalyticsAdapter({
    adapter: roxotAdapter,
    code: 'roxot'
});

export default roxotAdapter;

// FUNCTIONS ========================

function RoxotAnalyticAdapter() {

    return {
        utm: extractUtmData(),
        sessionId: extractSessionId(),
        send: function (originData) {
            let data = Object.assign({}, originData);
            Object.keys(data).map(function (objectKey) {
                let event = data[objectKey];

                event.data = event.data || {};
                event.data.utmTagData = extractUtmData();
                event.data.sessionId = extractSessionId();

            });

            return this.transport.send(data);
        },
        transport: {
            send: function (data) {
                //TODO why content type text/plain, is it important?
                let fullUrl = options.analyticHost + '?publisherId[]=' + options.publisherId + '&analyticHost=' + options.currentHost;
                ajax(fullUrl, null, JSON.stringify(data), {withCredentials: true});
            }
        },
        auction: {},
        eventStack: {

            stack: {},

            ensureRequestPresented: function (requestId) {
                if (!this.stack[requestId]) {
                    this.stack[requestId] = new Request(requestId, new Date(), options.publisherId);
                }
            },

            findRequest: function (requestId) {
                return this.stack[requestId];
            },
            clear: function () {
                this.stack = {};
            }
        },
        clear: function () {
            this.eventStack.clear();
            this.current = null;
        },
        current: null,
        track({eventType, args}) {
            args = args || {};

            if (eventType === CONSTANTS.EVENTS.AUCTION_INIT) {
                options.publisherId = args['config']['publisherIds'][0];

                if (args['config']['host'] !== undefined) {
                    options.currentHost = args['config']['host'];
                }

                if (args['config']['adUnits'] !== undefined) {
                    options.adUnits = args['config']['adUnits'];
                }
            }

            let requestId = args['requestId'] || this.current;

            if (this.current && this.current !== requestId) {
                throw 'Try to rewrite current auction';
            }

            this.current = requestId;
            this.eventStack.ensureRequestPresented(requestId);
            let request = this.eventStack.findRequest(requestId);

            let isImpression = eventType === CONSTANTS.EVENTS.BID_WON;
            let isBid = eventType === CONSTANTS.EVENTS.BID_ADJUSTMENT;
            let isBidAfterTimeout = (request.isFinished() && isBid);
            let isBidRequested = eventType === CONSTANTS.EVENTS.BID_REQUESTED;
            let isAuctionEnd = eventType === CONSTANTS.EVENTS.AUCTION_END;

            if (isBidRequested) {
                let placementCodes = args.bids.map((bid) => bid.placementCode);
                let timeout = args['timeout'];

                let auctions = placementCodes.map((placementCode) => request.ensureAdUnitPresented(placementCode, options.host, timeout));
                //todo check source
                let bidder = new Bidder(args['bidderCode'], args['source'] || '');
                return auctions.forEach((auction) => auction.bidderRequested(bidder));
            }

            if (isImpression || isBidAfterTimeout) {
                let originData = {
                    eventType: isBidAfterTimeout ? 'BidAfterTimeoutEvent' : 'AdUnitImpressionEvent',
                    auctionInfo: request.findAuction(args['adUnitCode']).auctionInfo,
                    data: {
                        size: args['width'] + 'x' + args['height'],
                        adUnitCode: args['adUnitCode'],
                        bidder: args['bidderCode'],
                        timeToRespond: args["timeToRespond"],
                        cpm: args['cpm']
                    }
                };

                let newEvent = {};
                newEvent[args['adUnitCode']] = originData;
                return this.send(newEvent);
            }

            if (isBid) {
                let auction = request.findAuction(args['adUnitCode']);
                // todo check timeToRespond,size,cpm
                let size = args['width'] + 'x' + args['height'];
                return auction.bidReceived(args['bidderCode'], args["timeToRespond"], size, args['cpm']);
            }

            if (isAuctionEnd) {
                this.current = null;
                request.finish();
                return this.send(request.buildData());
            }
        }
    };

    function extractSessionId() {
        let currentSessionId = (new SessionId).load();

        if (currentSessionId.isLive()) {
            currentSessionId.persist();
            return currentSessionId.id();
        }

        let newSessionId = (new SessionId).generate();
        newSessionId.persist();

        return newSessionId.id();

    }

    function extractUtmData() {
        let previousUtm = (new Utm).fromLocalStorage();
        let currentUtm = (new Utm).fromUrl(window.location);

        if (currentUtm.isDetected()) {
            currentUtm.persist();
            return currentUtm.data;
        }

        if (previousUtm.isLive()) {
            previousUtm.persist();
            return previousUtm.data;
        }

        return {};
    }
}

function Request(requestId, startedAt, publisherId) {
    this.requestId = requestId;
    this.publisherId = publisherId;
    this.auctions = {};
    this.isEnd = false;

    this.ensureAdUnitPresented = function (adUnitCode) {
        if (!this.auctions[adUnitCode]) {
            this.auctions[adUnitCode] = AuctionInfo(this.requestId, adUnitCode)
        }

        return this.auctions[adUnitCode];
    };

    this.findAuction = (adUnitCode) => this.auctions[adUnitCode];
    this.buildData = () => this.auctions;
    this.finish = () => this.isEnd = true;
    this.isFinished = () => this.isEnd;

    return this;

    function AuctionInfo(requestId, adUnitCode) {

        return {
            eventType: "AdUnitAuctionEvent",
            auctionInfo: {
                "requestId": requestId,
                "publisherId": publisherId,
                "adUnitCode": adUnitCode,
                "host": options.currentHost,
                "requestedBids": {},
                "bids": [],
                "bidsAfterTimeout": []
            },
            isFinished: false,
            finish: () => this.isFinished = true,
            bidderRequested: function (bidder) {
                this.auctionInfo.requestedBids[bidder.bidderCode] = bidder;
            },
            bidReceived: function (bidderCode, timeToRespond, size, cpm) {
                let bidder = this.auctionInfo.requestedBids[bidderCode];
                if (this.isFinished) {
                    this.auctionInfo.bidsAfterTimeout.push(new Bid(bidder, timeToRespond, size, cpm));
                }
                else {
                    this.auctionInfo.bids.push(new Bid(bidder, timeToRespond, size, cpm));
                }
            }

        };
    }


    function Bid(bidder, timeToRespond, size, cpm) {
        this.bidder = bidder;
        this.timeToRespond = timeToRespond;
        this.size = size;
        this.cpm = cpm;
    }
}

function Bidder(bidderCode, source) {
    this.bidderCode = bidderCode;
    this.source = source;
}

function SessionId(realId) {
    let key = options.prefix.concat('session_id');
    let timeout = {
        key: options.prefix.concat('session_timeout'),
        ms: 60 * 60 * 1000
    };
    let id = realId || null;
    let live = false;

    this.id = () => id;

    this.generate = function () {
        return new SessionId(uuid());
    };

    this.persist = function () {
        if (!live) {
            return utils.logError("Cann't persist rotten id");
        }

        localStorage.setItem(key, id);
        localStorage.setItem(timeout.key, Date.now());
    };

    this.isLive = function () {
        return isFresh();
    };
    this.load = function () {
        id = localStorage.getItem(key) || null;

        if (id && isFresh()) {
            live = true;
        }

        return this;

    };

    function isFresh() {
        let ts = localStorage.getItem(timeout.key);

        if (!ts) {
            return true;
        }

        return Date.now() - ts <= timeout.ms;
    }
}

function Utm() {
    let tags = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    let prefix = options.prefix.concat('utm');
    let timeout = {
        key: 'utm_timeout',
        ms: 60 * 60 * 1000
    };

    let detected = false;
    this.data = {};

    this.isDetected = function () {
        return detected;
    };

    this.isLive = function () {
        return detected && isFresh(localStorage.getItem(timeout.key) || 0);
    };

    this.fromUrl = function (url) {
        let $this = this;
        tags.forEach(function (tag) {
            let utmTagValue = parse(url).search[tag];

            if (utmTagValue !== '') {
                detected = true;
            }

            $this.data[tag] = utmTagValue;
        });

        return this;
    };

    this.fromLocalStorage = function () {
        let $this = this;
        tags.forEach(function (utmTagKey) {
            $this.data[utmTagKey] = localStorage.getItem(buildUtmLocalStorageKey(utmTagKey)) ? localStorage.getItem(buildUtmLocalStorageKey(utmTagKey)) : '';
        });

        return this;
    };

    this.persist = function () {
        let $this = this;
        Object.keys(this.data).map(function (tagKey, index) {
            localStorage.setItem(buildUtmLocalStorageKey(tagKey), $this.data[tagKey]);
        });

        localStorage.setItem(timeout.key, Date.now());
    };

    function buildUtmLocalStorageKey(key) {
        return prefix.concat(key);
    }

    function isFresh(utmTimestamp) {
        return (Date.now() - utmTimestamp) > timeout.ms;
    }

}

function uuid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }

    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
        s4() + '-' + s4() + s4() + s4();
}