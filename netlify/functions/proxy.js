const https = require("https");

function fetchWithRedirect(url, redirectCount, resolve) {
  if (redirectCount > 10) {
    resolve({ statusCode: 500, body: JSON.stringify({ error: "Too many redirects" }) });
    return;
  }
  https.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }, function(res) {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
      var location = res.headers.location;
      if (!location) { resolve({ statusCode: 500, body: JSON.stringify({ error: "Redirect with no location" }) }); return; }
      fetchWithRedirect(location, redirectCount + 1, resolve);
      return;
    }
    var data = "";
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() {
      resolve({
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: data
      });
    });
  }).on("error", function(err) {
    resolve({ statusCode: 500, body: JSON.stringify({ error: err.message }) });
  });
}

function slingFetch(url, authHeader, resolve, redirectCount) {
  if (!redirectCount) redirectCount = 0;
  if (redirectCount > 10) {
    resolve({ statusCode: 500, body: JSON.stringify({ error: "Too many redirects" }) });
    return;
  }
  var options = require("url").parse(url);
  options.headers = {
    "Authorization": authHeader,
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  https.get(options, function(res) {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
      var location = res.headers.location;
      if (!location) { resolve({ statusCode: 500, body: JSON.stringify({ error: "Redirect with no location" }) }); return; }
      slingFetch(location, authHeader, resolve, redirectCount + 1);
      return;
    }
    var data = "";
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() {
      resolve({
        statusCode: res.statusCode,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: data
      });
    });
  }).on("error", function(err) {
    resolve({ statusCode: 500, body: JSON.stringify({ error: err.message }) });
  });
}

exports.handler = async function(event) {
  var params = event.queryStringParameters || {};
  var action = params.action || "snapshot";

  if (action === "sling") {
    var from = params.from;
    var to = params.to;
    if (!from || !to) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Missing required params: from, to (YYYY-MM-DD)" })
      };
    }
    var slingUrl = "https://api.sling.is/v1/shifts?orgs=1121197"
      + "&from=" + encodeURIComponent(from + "T00:00:00")
      + "&to=" + encodeURIComponent(to + "T23:59:59");
    return new Promise(function(resolve) {
      slingFetch(slingUrl, process.env.SLING_API_KEY, resolve);
    });
  }

  var item = params.item || "";
  var GAS_URL = "https://script.google.com/macros/s/AKfycbxb_cPZwPnvW5ttLRTYK8qTieRtEhnm7y45Wib1tAQ87GRKuUDzQg1RDYaWxl6kCrCk9A/exec";
  var url = GAS_URL + "?action=" + action;
  if (item) url += "&item=" + encodeURIComponent(item);

  return new Promise(function(resolve) {
    fetchWithRedirect(url, 0, resolve);
  });
};
