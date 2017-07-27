import events from 'src/events';
import adaptermanager from 'src/adaptermanager';
import CONSTANTS from 'src/constants.json'

const utils = require('src/utils');
const url = window['roxot-price-floor-endpoint'] || '//pf.rxthdr.com';

let AUCTION_INIT_EVENT_TYPE = CONSTANTS.EVENTS.AUCTION_INIT;
let AUCTION_END_EVENT_TYPE = CONSTANTS.EVENTS.AUCTION_END;
let BID_REQUEST_EVENT_TYPE = CONSTANTS.EVENTS.BID_REQUESTED;
let BID_RESPONSE_EVENT_TYPE = CONSTANTS.EVENTS.BID_RESPONSE;
let BID_WON_EVENT_TYPE = CONSTANTS.EVENTS.BID_WON;

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
    events.on(AUCTION_INIT_EVENT_TYPE, _collect(AUCTION_INIT_EVENT_TYPE));
    events.on(BID_REQUEST_EVENT_TYPE, _collect(BID_REQUEST_EVENT_TYPE));
    events.on(BID_RESPONSE_EVENT_TYPE, _collect(BID_RESPONSE_EVENT_TYPE));
    events.on(AUCTION_END_EVENT_TYPE, _collect(AUCTION_END_EVENT_TYPE));
    events.on(BID_WON_EVENT_TYPE, _collect(BID_WON_EVENT_TYPE));
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
      if (eventType === AUCTION_INIT_EVENT_TYPE) {
        _flushEvents();
      } else if (eventType === AUCTION_END_EVENT_TYPE) {
        eventStack.priceFloorSettings = priceFloorSettings;
        eventStack.infoString = _extractInfoString();
        _send(eventType, eventStack, 'eventStack');
        _flushEvents();
      } else if (eventType === BID_WON_EVENT_TYPE) {
        let preparedEvent = _prepareEvent(eventType, event);
        let impressionStack = {events: [preparedEvent]};
        impressionStack.priceFloorSettings = priceFloorSettings;
        impressionStack.infoString = _extractInfoString();
        _send(BID_WON_EVENT_TYPE, impressionStack, 'Impression');
      } else {
        let preparedEvent = _prepareEvent(eventType, event);
        _pushEvent(eventType, preparedEvent);
      }
    }
  }
  var bidRequests = {};
  var bidResponses = {};

  function _prepareEvent(eventType, event) {
    if (eventType === BID_REQUEST_EVENT_TYPE) {
      let copyEvent = utils.cloneJson(event);
      delete copyEvent.bidderRequestId;
      delete copyEvent.auctionStart;
      delete copyEvent.start;
      delete copyEvent.timeout;
      copyEvent.bids.forEach(bid => {
        bidRequests[bid.requestId] = bidRequests[bid.requestId] || {};
        bidRequests[bid.requestId][bid.placementCode] = bidRequests[bid.requestId][bid.placementCode] || [];
        bidRequests[bid.requestId][bid.placementCode].push(event.bidderCode);
        delete bid.bidId;
        delete bid.bidder;
        delete bid.bidderRequestId;
        delete bid.requestId;
        delete bid.transactionId;
      });
      return copyEvent;
    }

    if (eventType === BID_RESPONSE_EVENT_TYPE) {
      let copyEvent = utils.cloneJson(event);
      bidResponses[event.requestId] = bidResponses[event.requestId] || {};
      bidResponses[event.requestId][event.adUnitCode] = bidResponses[event.requestId][event.adUnitCode] || [];
      bidResponses[event.requestId][event.adUnitCode][event.bidderCode] = event.cpm;
      delete copyEvent.ad;
      delete copyEvent.adId;
      delete copyEvent.adserverTargeting;
      delete copyEvent.bidder;
      delete copyEvent.pbAg;
      delete copyEvent.pbCg;
      delete copyEvent.pbDg;
      delete copyEvent.pbHg;
      delete copyEvent.pbLg;
      delete copyEvent.pbMg;
      delete copyEvent.requestTimestamp;
      delete copyEvent.responseTimestamp;
      delete copyEvent.statusMessage;
      return copyEvent;
    }

    if (eventType === BID_WON_EVENT_TYPE) {
      let impressionEvent = {eventType: 'Impression', args: {}};
      impressionEvent.args.requestId = event.requestId;
      impressionEvent.args.bidder = event.bidder;
      impressionEvent.args.cpm = event.cpm;
      impressionEvent.args.adUnitCode = event.adUnitCode;
      impressionEvent.args.auctionInfo = {};
      let requestedBidders = bidRequests[event.requestId][event.adUnitCode];
      let auctionResult = bidResponses[event.requestId][event.adUnitCode];
      for (let i in requestedBidders) {
        impressionEvent.args.auctionInfo[requestedBidders[i]] = auctionResult[requestedBidders[i]] || -1;
      }
      return impressionEvent;
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
