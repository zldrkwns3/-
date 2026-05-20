import http from "http";

const req = http.request(
  "http://localhost:3000/api/bot/config",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  },
  (res) => {
    res.setEncoding("utf8");
    res.on("data", console.log);
    setTimeout(() => {
      http.get("http://localhost:3000/api/bot/status", (res) => {
        let rawData = "";
        res.on("data", (chunk) => { rawData += chunk; });
        res.on("end", () => {
          try {
            const parsedData = JSON.parse(rawData);
            console.log("Logs:", parsedData.logs.slice(-5));
            console.log("isRunning:", parsedData.isRunning);
          } catch (e) {
            console.error(e.message);
          }
        });
      });
    }, 1000); // Wait 1 sec
  }
);
req.write(JSON.stringify({ action: "START" }));
req.end();
