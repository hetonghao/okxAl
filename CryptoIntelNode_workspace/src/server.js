import { createServer } from "node:http";

export function startServer({ app, host = "127.0.0.1", port = 8787 } = {}) {
  if (typeof app !== "function") throw new TypeError("app is required");
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
