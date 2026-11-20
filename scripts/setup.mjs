import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { isIPv4 } from "node:net";
const ip = process.argv[2];
if (!isIPv4(ip) || ip === "0.0.0.0")
  throw new Error(
    "Укажите IPv4 компьютера в локальной сети: node scripts/setup.mjs 192.168.1.50",
  );
if (existsSync(".env") || existsSync("config/livekit.yaml"))
  throw new Error(
    "Настройки уже существуют. Сохраните их копию и удалите .env и config/livekit.yaml перед повторной настройкой.",
  );
const teacher = randomBytes(24).toString("hex"),
  key = "clasp" + randomBytes(8).toString("hex"),
  secret = randomBytes(32).toString("hex");
mkdirSync("config", { recursive: true });
writeFileSync(
  ".env",
  `CLASSROOM_IP=${ip}\nTEACHER_KEY=${teacher}\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\nLIVEKIT_URL=wss://${ip}/livekit\nDATA_DIR=./data\n`,
  { mode: 0o600 },
);
writeFileSync(
  "config/livekit.yaml",
  `port: 7880\nbind_addresses: ["0.0.0.0"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: ${ip}\n  stun_servers: []\nkeys:\n  ${key}: ${secret}\n`,
  { mode: 0o600 },
);
writeFileSync(
  "config/Caddyfile",
  `https://${ip} {\n  tls internal\n  handle_path /livekit* {\n    reverse_proxy livekit:7880\n  }\n  handle {\n    reverse_proxy app:3000 {\n      flush_interval -1\n    }\n  }\n}\n`,
);
console.log(
  `Готово. Адрес аудитории: https://${ip}\nКлюч преподавателя записан в .env (TEACHER_KEY). Не передавайте этот файл студентам.`,
);
