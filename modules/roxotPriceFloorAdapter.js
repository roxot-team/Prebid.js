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

let REQUEST_ROXOT_EVENT_TYPE = 'request';
let RESPONSE_ROXOT_EVENT_TYPE = 'response';
let IMPRESSION_ROXOT_EVENT_TYPE = 'impression';

let priceFloorSettings = {};
let roxotPriceFloorAdapter = function RoxotPriceFloorAdapter() {
  let eventStack = {events: [], priceFloorSettings: {}};

  function _prepareAdUnits(adUnits) {
    adUnits.forEach(function (adUnit) {
      let affectedBidders = {};
      let config = _getPriceFloorConfig(adUnit.code);
      adUnit.bids.forEach(function (bid) {
        let bidder = bid.bidder;
        if (!(bidder in config)) {
          return;
        }
        let bidderConfig = config[bidder];
        let priceFloorKey = bidderConfig.key;
        if (priceFloorKey in bid.params) {
          return;
        }
        bid.params[priceFloorKey] = bidderConfig.value;
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
        eventStack.priceFloorSettings = priceFloorSettings;
        eventStack.infoString = _extractInfoString();
        _send(eventType, eventStack, 'eventStack');
        _flushEvents();
      } else if (eventType === BID_WON_PREBID_EVENT_TYPE) {
        let preparedEvent = _prepareEvent(eventType, event);
        let impressionStack = {events: [preparedEvent]};
        impressionStack.priceFloorSettings = priceFloorSettings;
        impressionStack.infoString = _extractInfoString();
        _send(BID_WON_PREBID_EVENT_TYPE, impressionStack, 'Impression');
      } else if (eventType === BID_REQUEST_PREBID_EVENT_TYPE) {
        let preparedEvent = _prepareEvent(eventType, event);
        _pushEvent(REQUEST_ROXOT_EVENT_TYPE, preparedEvent);
      }
      else if (eventType === BID_RESPONSE_PREBID_EVENT_TYPE) {
        let preparedEvent = _prepareEvent(eventType, event);
        _pushEvent(RESPONSE_ROXOT_EVENT_TYPE, preparedEvent);
      }
    }
  }
  var bidRequests = {};
  var bidResponses = {};

  function _prepareEvent(eventType, event) {
    if (eventType === BID_REQUEST_PREBID_EVENT_TYPE) {
      let roxotEvent = utils.cloneJson(event);
      roxotEvent.eventType = REQUEST_ROXOT_EVENT_TYPE;
      delete roxotEvent.bidderRequestId;
      delete roxotEvent.auctionStart;
      delete roxotEvent.start;
      delete roxotEvent.timeout;
      roxotEvent.bids.forEach(bid => {
        bidRequests[bid.requestId] = bidRequests[bid.requestId] || {};
        bidRequests[bid.requestId][bid.placementCode] = bidRequests[bid.requestId][bid.placementCode] || [];
        bidRequests[bid.requestId][bid.placementCode].push(event.bidderCode);
        delete bid.bidId;
        delete bid.bidder;
        delete bid.bidderRequestId;
        delete bid.requestId;
        delete bid.transactionId;
      });
      return roxotEvent;
    }

    if (eventType === BID_RESPONSE_PREBID_EVENT_TYPE) {
      let roxotEvent = utils.cloneJson(event);
      roxotEvent.eventType = RESPONSE_ROXOT_EVENT_TYPE;
      bidResponses[event.requestId] = bidResponses[event.requestId] || {};
      bidResponses[event.requestId][event.adUnitCode] = bidResponses[event.requestId][event.adUnitCode] || [];
      bidResponses[event.requestId][event.adUnitCode][event.bidderCode] = event.cpm;
      delete roxotEvent.ad;
      delete roxotEvent.adId;
      delete roxotEvent.adserverTargeting;
      delete roxotEvent.bidder;
      delete roxotEvent.pbAg;
      delete roxotEvent.pbCg;
      delete roxotEvent.pbDg;
      delete roxotEvent.pbHg;
      delete roxotEvent.pbLg;
      delete roxotEvent.pbMg;
      delete roxotEvent.requestTimestamp;
      delete roxotEvent.responseTimestamp;
      delete roxotEvent.statusMessage;
      return roxotEvent;
    }

    if (eventType === BID_WON_PREBID_EVENT_TYPE) {
      let roxotEvent = {
        eventType: IMPRESSION_ROXOT_EVENT_TYPE,
        args: {}
      };
      roxotEvent.args.requestId = event.requestId;
      roxotEvent.args.bidderCode = event.bidder;
      roxotEvent.args.cpm = event.cpm;
      roxotEvent.args.adUnitCode = event.adUnitCode;
      roxotEvent.args.auctionInfo = {};
      let requestedBidders = bidRequests[event.requestId][event.adUnitCode];
      let auctionResult = bidResponses[event.requestId][event.adUnitCode];
      for (let i in requestedBidders) {
        roxotEvent.args.auctionInfo[requestedBidders[i]] = auctionResult[requestedBidders[i]] || -1;
      }
      return roxotEvent;
    }

    return event;
  }

  function _pushEvent(eventType, args) {
    eventStack.events.push({eventType, args});
  }

  function _flushEvents() {
    eventStack.events = [];
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
