import events from 'src/events';
import adaptermanager from 'src/adaptermanager';
import CONSTANTS from 'src/constants.json'

const utils = require('src/utils');
const url = window['roxot-price-floor-endpoint'] || '//pf.rxthdr.com';

let AUCTION_INIT_PREBID_EVENT_TYPE = CONSTANTS.EVENTS.AUCTION_INIT;
let AUCTION_END_PREBID_EVENT_TYPE = CONSTANTS.EVENTS.AUCTION_END;
let BID_REQUEST_PREBID_EVENT_TYPE = CONSTANTS.EVENTS.BID_REQUESTED;
let BID_RESPONSE_PREBID_EVENT_TYPE = CONSTANTS.EVENTS.BID_RESPONSE;
let BID_WON_PREBID_EVENT_TYPE = CONSTANTS.EVENTS.BID_WON;

let AUCTION_ROXOT_EVENT_TYPE = 'auction';
let IMPRESSION_ROXOT_EVENT_TYPE = 'impression';

let priceFloorSettings = {};
let previousPriceFloorSettings = {};
let roxotPriceFloorAdapter = function RoxotPriceFloorAdapter() {
  let bidRequests = {};
  let bidResponses = {};

  function _prepareAdUnits(adUnits) {
    adUnits.forEach(function (adUnit) {
      let affectedBidders = {};
      let config = _getPriceFloorConfig(adUnit.code);
      let previousAdUnitPriceFloorSettings = previousPriceFloorSettings[adUnit.code] || {};
      adUnit.bids.forEach(function (bid) {
        let bidder = bid.bidder;
        if (typeof previousAdUnitPriceFloorSettings[bidder] !== 'undefined') {
          delete bid.params[previousAdUnitPriceFloorSettings[bidder]];
        }
        if (!(bidder in config)) {
          return;
        }
        let bidderConfig = config[bidder];
        let priceFloorKey = bidderConfig.key;
        if (priceFloorKey in bid.params) {
          return;
        }
        bid.params[priceFloorKey] = bidderConfig.value;
        previousPriceFloorSettings[adUnit.code] = previousPriceFloorSettings[adUnit.code] || {};
        previousPriceFloorSettings[adUnit.code][bidder] = priceFloorKey;
        affectedBidders[bidder] = 1;
        priceFloorSettings[adUnit.code] = priceFloorSettings[adUnit.code] || {};
        priceFloorSettings[adUnit.code][bidder] = bidderConfig.value;
      });
      for (let bidder in affectedBidders) {
        let ttl = config[bidder].ttl;
        ttl--;
        if (ttl <= 0) {
          delete config[bidder];
        } else {
          config[bidder].ttl = ttl;
        }
      }
      if (Object.keys(config).length === 0) {
        _removePriceFloorConfig(adUnit.code);
      } else {
        _updatePriceFloorConfig(adUnit.code, config);
      }
    });
  }

  function _init() {
    events.on(AUCTION_INIT_PREBID_EVENT_TYPE, _collect(AUCTION_INIT_PREBID_EVENT_TYPE));
    events.on(BID_REQUEST_PREBID_EVENT_TYPE, _collect(BID_REQUEST_PREBID_EVENT_TYPE));
    events.on(BID_RESPONSE_PREBID_EVENT_TYPE, _collect(BID_RESPONSE_PREBID_EVENT_TYPE));
    events.on(AUCTION_END_PREBID_EVENT_TYPE, _collect(AUCTION_END_PREBID_EVENT_TYPE));
    events.on(BID_WON_PREBID_EVENT_TYPE, _collect(BID_WON_PREBID_EVENT_TYPE));
  }

  function _getPriceFloorConfig(adUnitCode) {
    let configName = _buildConfigName(adUnitCode);
    let config = localStorage.getItem(configName);
    if (!config) {
      return {};
    }
    return JSON.parse(config);
  }

  function _updatePriceFloorConfig(adUnitCode, config) {
    let configName = _buildConfigName(adUnitCode);
    let configString = JSON.stringify(config);
    localStorage.setItem(configName, configString);
  }

  function _removePriceFloorConfig(adUnitCode) {
    let configName = _buildConfigName(adUnitCode);
    localStorage.removeItem(configName);
  }

  function _buildConfigName(name) {
    return 'roxot_pf_' + name;
  }

  function _send(eventType, data, sendDataType) {
    let xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.withCredentials = true;
    xhr.onreadystatechange = function (result) {
      if (this.readyState != 4) return;
      try {
        _updateSettings(JSON.parse(xhr.responseText));
      } catch (error) {
        console.error(error);
      }
      utils.logInfo('Event ' + eventType + ' sent ' + sendDataType + ' to roxot price floor service with result ' + result);
    };
    xhr.send(JSON.stringify(data));
  }

  function _updateSettings(body) {
    if ('infoString' in body) {
      localStorage.setItem(_buildConfigName('info-string'), body.infoString);
    }

    if ('config' in body) {
      for (let adUnitCode in body.config) {
        let config = _getPriceFloorConfig(adUnitCode);
        let biddersConfig = body.config[adUnitCode];
        for (let bidder in biddersConfig) {
          config[bidder] = biddersConfig[bidder];
        }
        _updatePriceFloorConfig(adUnitCode, config);
      }
    }
  }

  function _collect(eventType) {
    return function (event) {
      if (eventType === AUCTION_INIT_PREBID_EVENT_TYPE) {
        _flushEvents();
      } else if (eventType === AUCTION_END_PREBID_EVENT_TYPE) {
        let eventStack = {
          priceFloorSettings: priceFloorSettings,
          infoString: _extractInfoString(),
          events: _solveAuctionEvents(bidRequests, bidResponses),
          eventStackType: AUCTION_ROXOT_EVENT_TYPE
        };
        _send(AUCTION_ROXOT_EVENT_TYPE, eventStack, AUCTION_ROXOT_EVENT_TYPE);
      } else if (eventType === BID_WON_PREBID_EVENT_TYPE) {
        let impressionStack = {
          event: _prepareEvent(eventType, event),
          priceFloorSettings: priceFloorSettings,
          infoString: _extractInfoString(),
          eventStackType: IMPRESSION_ROXOT_EVENT_TYPE
        };
        _send(IMPRESSION_ROXOT_EVENT_TYPE, impressionStack, IMPRESSION_ROXOT_EVENT_TYPE);
      } else if (eventType === BID_REQUEST_PREBID_EVENT_TYPE) {
        _prepareEvent(eventType, event);
      }
      else if (eventType === BID_RESPONSE_PREBID_EVENT_TYPE) {
        _prepareEvent(eventType, event);
      }
    };
  }

  function _solveAuctionEvents(bidRequests, bidResponses) {
    let auctions = [];
    for (let requestId in bidRequests) {
      for (let adUnitCode in bidRequests[requestId]) {
        let auction = {};
        let auctionBidders = bidRequests[requestId][adUnitCode];
        auction.adUnitCode = adUnitCode;
        auction.requestId = requestId;
        auction.bidders = {};
        for (let bidderIndex in auctionBidders) {
          let bidderCode = auctionBidders[bidderIndex];
          auction.bidders[bidderCode] = bidResponses[requestId][adUnitCode][bidderCode];
        }
        auctions.push(auction);
      }
    }
    return auctions;
  }

  function _prepareEvent(eventType, event) {
    if (eventType === BID_REQUEST_PREBID_EVENT_TYPE) {
      event.bids.forEach(bid => {
        bidRequests[bid.requestId] = bidRequests[bid.requestId] || {};
        bidRequests[bid.requestId][bid.placementCode] = bidRequests[bid.requestId][bid.placementCode] || [];
        bidRequests[bid.requestId][bid.placementCode].push(event.bidderCode);
      });
    }

    if (eventType === BID_RESPONSE_PREBID_EVENT_TYPE) {
      bidResponses[event.requestId] = bidResponses[event.requestId] || {};
      bidResponses[event.requestId][event.adUnitCode] = bidResponses[event.requestId][event.adUnitCode] || [];
      if (bidResponses[event.requestId][event.adUnitCode][event.bidderCode]) {
        let existingResponseCpm = bidResponses[event.requestId][event.adUnitCode][event.bidderCode].cpm;
        if (event.cpm > existingResponseCpm) {
          bidResponses[event.requestId][event.adUnitCode][event.bidderCode] = {cpm: event.cpm, size: {width: event.width, height: event.height}};
        }
      } else {
        bidResponses[event.requestId][event.adUnitCode][event.bidderCode] = {cpm: event.cpm, size: {width: event.width, height: event.height}};
      }
    }

    if (eventType === BID_WON_PREBID_EVENT_TYPE) {
      let roxotEvent = {
        requestId: event.requestId,
        bidderCode: event.bidder,
        cpm: event.cpm,
        adUnitCode: event.adUnitCode,
        auctionInfo: {}
      };
      let requestedBidders = bidRequests[event.requestId][event.adUnitCode] || {};
      let auctionResult = bidResponses[event.requestId][event.adUnitCode] || {};
      for (let i in requestedBidders) {
        roxotEvent.auctionInfo[requestedBidders[i]] = auctionResult[requestedBidders[i]] || -1;
      }
      return roxotEvent;
    }

    return event;
  }

  function _flushEvents() {
    bidResponses = {};
    bidRequests = {};
  }

  function _extractInfoString() {
    let configName = _buildConfigName('info-string');
    return localStorage.getItem(configName) || '';
  }

  return {
    prepareAdUnits: _prepareAdUnits,
    init: _init
  };
};

adaptermanager.registerPriceFloorAdapter({
  adapter: roxotPriceFloorAdapter,
  title: 'roxot'
});

export default roxotPriceFloorAdapter;
