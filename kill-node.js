import { execSync } from "child_process";
try {
  execSync("pkill node");
} catch(e) {}
