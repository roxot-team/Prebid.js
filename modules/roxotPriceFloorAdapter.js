import events from 'src/events';
import adaptermanager from 'src/adaptermanager';
import CONSTANTS from 'src/constants.json'

const utils = require('src/utils');
const url = window['roxot-price-floor-endpoint'] || '//pf.rxthdr.com';

let auctionInitConst = CONSTANTS.EVENTS.AUCTION_INIT;
let auctionEndConst = CONSTANTS.EVENTS.AUCTION_END;
let bidRequestedConst = CONSTANTS.EVENTS.BID_REQUESTED;
let bidResponseConst = CONSTANTS.EVENTS.BID_RESPONSE;

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
      for(let bidder in affectedBidders) {
        let ttl = config[bidder].ttl;
        ttl--;
        if (ttl <= 0) {
          delete config[bidder];
        } else {
          config[bidder].ttl = ttl;
        }
      }
      if (Object.keys(config).length === 0){
        _removePriceFloorConfig(adUnit.code);
      } else {
        _updatePriceFloorConfig(adUnit.code, config);
      }
    });
  }

  function _init() {
    events.on(auctionInitConst, _collect(auctionInitConst));
    events.on(bidRequestedConst, _collect(bidRequestedConst));
    events.on(bidResponseConst, _collect(bidResponseConst));
    events.on(auctionEndConst, _collect(auctionEndConst));
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

  function _buildConfigName(name){
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
    if('infoString' in body) {
      localStorage.setItem(_buildConfigName('info-string'), body.infoString);
    }

    if('config' in body) {
      for(let adUnitCode in body.config) {
        let config = _getPriceFloorConfig(adUnitCode);
        let biddersConfig = body.config[adUnitCode];
        for(let bidder in biddersConfig) {
          config[bidder] = biddersConfig[bidder];
        }
        _updatePriceFloorConfig(adUnitCode, config);
      }
    }
  }

  function _collect(eventType) {
    return function (event) {
      if (eventType === auctionInitConst) {
        _flushEvents();
      } else if (eventType === auctionEndConst) {
        eventStack.priceFloorSettings = priceFloorSettings;
        eventStack.infoString = _extractInfoString();
        _send(eventType, eventStack, 'eventStack');
        _flushEvents();
      } else {
        _pushEvent(eventType, event);
      }
    }
  }

  function _pushEvent(eventType, args) {
    eventStack.events.push({eventType, args});
  }

  function _flushEvents() {
    eventStack.events = [];
  }

  function _extractInfoString() {
    let configName = _buildConfigName('info-string');
    return localStorage.getItem(configName) || "";
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