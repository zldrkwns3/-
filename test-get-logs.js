import http from "http";

http.get("http://localhost:3000/api/bot/status", (res) => {
  let rawData = "";
  res.on("data", (chunk) => { rawData += chunk; });
  res.on("end", () => {
    try {
      const parsedData = JSON.parse(rawData);
      console.log("Logs count:", parsedData.logs.length);
      console.log("Last 20 Logs:", parsedData.logs.slice(-20));
      console.log("isRunning:", parsedData.isRunning);
    } catch (e) {
      console.error(e.message);
    }
  });
});
