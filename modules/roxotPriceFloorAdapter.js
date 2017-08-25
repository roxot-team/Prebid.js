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

let currentPriceFloorSettings = {};
let priceFloorSettings = {};
let roxotPriceFloorAdapter = function RoxotPriceFloorAdapter() {
  let bidRequests = {};
  let bidResponses = {};
  let auctionStartPoints = {};
  let currentRequestId;

  function _prepareAdUnits(adUnits) {
    adUnits.forEach(function (adUnit) {
      let affectedBidders = {};
      let config = _getPriceFloorConfig(adUnit.code);
      let previousAdUnitPriceFloorSettings = currentPriceFloorSettings[adUnit.code] || {};
      adUnit.bids.forEach(function (bid) {
        let bidder = bid.bidder;
        if (typeof previousAdUnitPriceFloorSettings[bidder] !== 'undefined') {
          delete bid.params[previousAdUnitPriceFloorSettings[bidder].key];
          delete currentPriceFloorSettings[adUnit.code][bidder];
          if (Object.keys(currentPriceFloorSettings[adUnit.code]).length === 0) {
            delete currentPriceFloorSettings[adUnit.code];
          }
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
        currentPriceFloorSettings[adUnit.code] = currentPriceFloorSettings[adUnit.code] || {};
        currentPriceFloorSettings[adUnit.code][bidder] = bidderConfig;
        affectedBidders[bidder] = 1;
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
    events.on(AUCTION_INIT_PREBID_EVENT_TYPE, _catchEvent(AUCTION_INIT_PREBID_EVENT_TYPE));
    events.on(BID_REQUEST_PREBID_EVENT_TYPE, _catchEvent(BID_REQUEST_PREBID_EVENT_TYPE));
    events.on(BID_RESPONSE_PREBID_EVENT_TYPE, _catchEvent(BID_RESPONSE_PREBID_EVENT_TYPE));
    events.on(AUCTION_END_PREBID_EVENT_TYPE, _catchEvent(AUCTION_END_PREBID_EVENT_TYPE));
    events.on(BID_WON_PREBID_EVENT_TYPE, _catchEvent(BID_WON_PREBID_EVENT_TYPE));
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

  function _send(data) {
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
      utils.logInfo('Event ' + data.eventStackType + ' sent to roxot price floor service with result ' + result);
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

  function _catchEvent(eventType) {
    return function (event) {
      if (eventType === AUCTION_INIT_PREBID_EVENT_TYPE) {
        currentRequestId = event.requestId;
        _flushEvents(event.timestamp);
        priceFloorSettings[event.requestId] = currentPriceFloorSettings;
        auctionStartPoints[event.requestId] = event.timestamp;
      } else if (eventType === AUCTION_END_PREBID_EVENT_TYPE) {
        let eventStack = {
          time: (new Date().getTime()),
          priceFloorSettings: priceFloorSettings[currentRequestId],
          infoString: _extractInfoString(),
          events: _buildAuctionEvents(currentRequestId),
          eventStackType: AUCTION_ROXOT_EVENT_TYPE
        };
        _pushAuctionToEventHistory(eventStack);
        eventStack.eventHistory = _getEventHistory();
        _send(eventStack);
      } else if (eventType === BID_WON_PREBID_EVENT_TYPE) {
        let eventStack = {
          time: (new Date().getTime()),
          priceFloorSettings: priceFloorSettings[event.requestId],
          infoString: _extractInfoString(),
          event: _buildImpressionEvent(event.requestId, event.bidderCode, event.adUnitCode, event.cpm, {width: event.width, height: event.height}),
          eventStackType: IMPRESSION_ROXOT_EVENT_TYPE
        };
        _pushImpressionToEventHistory(eventStack);
        eventStack.eventHistory = _getEventHistory();
        _send(eventStack);
      } else if (eventType === BID_REQUEST_PREBID_EVENT_TYPE) {
        _keepBidRequestEvent(event);
      } else if (eventType === BID_RESPONSE_PREBID_EVENT_TYPE) {
        _keepBidResponseEvent(event);
      }
    };
  }

  function _pushAuctionToEventHistory(eventStack) {
    _pushToEventHistory(eventStack);
  }

  function _pushImpressionToEventHistory(eventStack) {
    _pushToEventHistory(eventStack);
  }

  function _pushToEventHistory(eventStack) {
    let history = _getEventHistory();
    history.push(eventStack);

    localStorage.setItem(_buildEventHistoryKey(), JSON.stringify(history));
  }

  function _getEventHistory() {
    let historyString = localStorage.getItem(_buildEventHistoryKey());
    if (!historyString) {
      return [];
    }

    return JSON.parse(historyString);
  }

  function _buildEventHistoryKey() {
    return 'roxot_pfh';
  }

  function _buildAuctionEvents(currentRequestId) {
    let auctions = [];
    for (let adUnitCode in bidRequests[currentRequestId]) {
      let auction = {
        requestId: currentRequestId,
        adUnitCode: adUnitCode,
        auctionInfo: {}
      };
      let auctionBidders = bidRequests[currentRequestId][adUnitCode];
      for (let bidderIndex in auctionBidders) {
        let bidderCode = auctionBidders[bidderIndex];
        auction.auctionInfo[bidderCode] = bidResponses[currentRequestId][adUnitCode][bidderCode] || {cpm: -1, size: {width: 0, height: 0}};
      }
      auctions.push(auction);
    }
    return auctions;
  }

  function _buildImpressionEvent(requestId, bidderCode, adUnitCode, cpm, size) {
    let impression = {
      requestId: requestId,
      impressionInfo: {
        bidderCode: bidderCode,
        cpm: cpm,
        size: size
      },
      adUnitCode: adUnitCode,
      auctionInfo: {}
    };
    let requestedBidders = bidRequests[requestId][adUnitCode] || {};
    let auctionResult = bidResponses[requestId][adUnitCode] || {};
    for (let i in requestedBidders) {
      impression.auctionInfo[requestedBidders[i]] = auctionResult[requestedBidders[i]] || {cpm: -1, size: {width: 0, height: 0}};
    }
    return impression;
  }

  function _keepBidRequestEvent(event) {
    event.bids.forEach(bid => {
      bidRequests[bid.requestId] = bidRequests[bid.requestId] || {};
      bidRequests[bid.requestId][bid.placementCode] = bidRequests[bid.requestId][bid.placementCode] || [];
      bidRequests[bid.requestId][bid.placementCode].push(event.bidderCode);
    });
  }

  function _keepBidResponseEvent(event) {
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

  function _flushEvents(timestamp) {
    for (let i in auctionStartPoints) {
      if (parseInt(timestamp) - parseInt(auctionStartPoints[i]) >= 6 * 6 * 1000) {
        delete bidRequests[i];
        delete bidResponses[i];
        delete priceFloorSettings[i];
      }
    }
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
