'use strict';
var CONSTANTS = require('src/constants.json');
var utils = require('src/utils.js');
var bidfactory = require('src/bidfactory.js');
var bidmanager = require('src/bidmanager.js');
var adloader = require('src/adloader');
var adaptermanager = require('src/adaptermanager');

var roxotDynamicBidAdapterForTestAdapter = function roxotDynamicBidAdapterForTestAdapter(bidderCode, url) {
  let handlerName = 'dynamic_roxot_' + bidderCode + '_responseHandler';
  $$PREBID_GLOBAL$$[handlerName] = roxotDynamicBidResponseHandler;

  return {
    callBids: _callBids
  };

  function _callBids(bidReqs) {
    utils.logInfo('callBids roxot adapter invoking');

    var domain = window.location.host;
    var page = window.location.pathname + location.search + location.hash;

    var roxotBidReqs = {
      id: utils.getUniqueIdentifierStr(),
      bids: bidReqs,
      site: {
        domain: domain,
        page: page
      }
    };

    var scriptUrl = '//' + url + 'callback=pbjs.' + handlerName +
      '&src=' + CONSTANTS.REPO_AND_VERSION +
      '&br=' + encodeURIComponent(JSON.stringify(roxotBidReqs));

    adloader.loadScript(scriptUrl);
  }

  function roxotDynamicBidResponseHandler(roxotDynamicResponseObject) {
    utils.logInfo('roxotDynamicBidResponseHandler invoking');
    var placements = [];

    if (isResponseInvalid()) {
      return fillPlacementEmptyBid();
    }

    roxotDynamicResponseObject.bids.forEach(pushCustomRoxotBid);
    var allBidResponse = fillPlacementEmptyBid(placements);
    utils.logInfo('roxotResponse handler finish');

    return allBidResponse;

    function isResponseInvalid() {
      return !roxotDynamicResponseObject || !roxotDynamicResponseObject.bids || !Array.isArray(roxotDynamicResponseObject.bids) || roxotDynamicResponseObject.bids.length <= 0;
    }

    function pushCustomRoxotBid(roxotBid) {
      var bidReq = $$PREBID_GLOBAL$$
        ._bidsRequested.find(bidSet => bidSet.bidderCode === bidderCode)
        .bids.find(bid => bid.bidId === roxotBid.bidId);

      if (!bidReq) {
        utils.logWarn('Can not find response for one of requests.');
        return;
      }

      bidReq.status = CONSTANTS.STATUS.GOOD;

      var cpm = roxotBid.cpm;

      if (!cpm) {
        return pushErrorBid(bidReq);
      }

      var bid = bidfactory.createBid(1, bidReq);

      bid.creative_id = roxotBid.id;
      bid.bidderCode = bidderCode;
      bid.cpm = cpm;
      var responseNurl = '<img src="' + roxotBid.nurl + '">';
      bid.ad = decodeURIComponent(roxotBid.adm + responseNurl);
      bid.width = parseInt(roxotBid.w);
      bid.height = parseInt(roxotBid.h);

      bidmanager.addBidResponse(bidReq.placementCode, bid);
    }

    function fillPlacementEmptyBid(places) {
      $$PREBID_GLOBAL$$
        ._bidsRequested.find(bidSet => bidSet.bidderCode === bidderCode)
        .bids.forEach(fillIfNotFilled);

      function fillIfNotFilled(bid) {
        if (utils.contains(places, bid.placementCode)) {
          return null;
        }

        pushErrorBid(bid);
      }
    }

    function pushErrorBid(bidRequest) {
      var bid = bidfactory.createBid(2, bidRequest);
      bid.bidderCode = bidderCode;
      bidmanager.addBidResponse(bidRequest.placementCode, bid);
    }
  }
};

var roxotBidderConfigBidders = window.roxotBidderConfig.bidders;

for (var bidderIndex in roxotBidderConfigBidders) {
  if (!roxotBidderConfigBidders.hasOwnProperty(bidderIndex)) {
    continue;
  }

  var roxotBidderConfig = roxotBidderConfigBidders[bidderIndex];
  adaptermanager.registerBidAdapter(new roxotDynamicBidAdapterForTestAdapter(roxotBidderConfig.name, roxotBidderConfig.url), roxotBidderConfig.name);
}

module.exports = roxotDynamicBidAdapterForTestAdapter;