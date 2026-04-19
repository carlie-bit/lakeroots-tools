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

function slingLogin() {
  return new Promise(function(resolve, reject) {
    var postData = JSON.stringify({
      email: process.env.SLING_EMAIL,
      password: process.env.SLING_PASSWORD
    });
    var options = require("url").parse("https://api.sling.is/account/login");
    options.method = "POST";
    options.headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0",
      "Content-Length": Buffer.byteLength(postData)
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode >= 400) {
          reject(new Error("Sling login failed (" + res.statusCode + "): " + data.slice(0, 500)));
          return;
        }
        var auth = res.headers["authorization"];
        if (!auth) {
          try {
            var body = JSON.parse(data);
            auth = body.token || body.authorization || body.Authorization;
          } catch(e) {}
        }
        if (!auth) {
          reject(new Error("No auth token in Sling login response. Headers: " + JSON.stringify(res.headers) + " Body: " + data.slice(0, 500)));
          return;
        }
        resolve(auth);
      });
    });
    req.on("error", function(err) { reject(err); });
    req.write(postData);
    req.end();
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
    try {
      var token = await slingLogin();
      return new Promise(function(resolve) {
        slingFetch(slingUrl, token, resolve);
      });
    } catch(err) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Sling login failed: " + err.message })
      };
    }
  }

  var item = params.item || "";
  var GAS_URL = "https://script.google.com/macros/s/AKfycbze-3pGiyMcJigvO_N0MPs4E5tnvI3AZz7FO4oNP30d8DKW8p1duwB7jTgdcBgKIEQMnw/exec";
  var url = GAS_URL + "?action=" + action;
  if (item) url += "&item=" + encodeURIComponent(item);

  return new Promise(function(resolve) {
    fetchWithRedirect(url, 0, resolve);
  });
};
