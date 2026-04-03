const https = require("https");

exports.handler = async function(event) {
  const action = event.queryStringParameters?.action || "snapshot";
  const item   = event.queryStringParameters?.item   || "";
  
  const GAS_URL = "https://script.google.com/macros/s/AKfycbxb_cPZwPnvW5ttLRTYK8qTieRtEhnm7y45Wib1tAQ87GRKuUDzQg1RDYaWxl6kCrCk9A/exec";
  
  let url = `${GAS_URL}?action=${action}`;
  if (item) url += `&item=${encodeURIComponent(item)}`;

  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: data
      }));
    }).on("error", (err) => resolve({
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }));
  });
};
