function generateRandomId() {
  return crypto.randomUUID();
}

export async function PunchmoleServer(
  port: number,
  apiKeys: string[],
  endpointUrlPath = "/_punchmole",
  log = console,
) {
  if (apiKeys.filter((v) => v !== "").length === 0) {
    throw new Error("invalid api keys, please check apiKeys argument");
  }

  const domainsToConnections: {
    [key: string]: { status: string; socket: WebSocket };
  } = {};
  let openRequests: {
    [key: string]: {
      resolve: (value: Response | PromiseLike<Response>) => void;
      headers: Headers;
      body: string;
    };
  } = {};
  let openWebsocketConnections: { [key: string]: { socket: WebSocket } } = {};

  function getRequestObject(id: string) {
    return openRequests[id];
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const requestedDomain = req.headers.get("host")?.split(":")[0] || "";

    if (req.headers.get("upgrade") === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);

      socket.onopen = () => {
        log.info(
          new Date(),
          "client connection open",
          req.headers,
          url.pathname,
        );

        if (url.pathname === endpointUrlPath) {
          let socketDomain: string;
          socket.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            let request: any = null;
            if (message.id) {
              request = getRequestObject(message.id);
            }

            switch (message.type) {
              case "register":
                if (apiKeys.includes(message.apiKey)) {
                  log.info(
                    new Date(),
                    "registering socket for domain",
                    message,
                  );
                  socketDomain = message.domain;
                  domainsToConnections[message.domain] = {
                    status: "alive",
                    socket: socket,
                  };
                  socket.send(
                    JSON.stringify({
                      type: "registered",
                      domain: message.domain,
                    }),
                  );
                } else {
                  log.error(
                    new Date(),
                    "given api key is wrong/not recognised, stopping connection",
                    message,
                  );
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      message: "invalid api key",
                    }),
                  );
                  socket.close();
                }
                break;

              case "response-start":
                log.info(
                  new Date(),
                  "response start, request id",
                  message.id,
                  message.headers,
                );
                if (request) {
                  request.headers = new Headers(message.headers);
                  request.body = "";
                } else {
                  log.error(
                    new Date(),
                    "didn't find response object, probably dead?",
                  );
                }
                break;

              case "data":
                if (request) {
                  const data = new TextDecoder().decode(
                    new Uint8Array(message.data),
                  );
                  request.body += data;
                } else {
                  log.error(
                    new Date(),
                    "didn't find response object, unable to send data",
                    message.id,
                  );
                }
                break;

              case "data-end":
                log.info(
                  new Date(),
                  "finishing sending data for request",
                  message.id,
                );
                if (request) {
                  request.body += new TextDecoder().decode(
                    new Uint8Array(message.data),
                  );
                  request.resolve(
                    new Response(request.body, {
                      headers: request.headers,
                    }),
                  );
                  delete openRequests[message.id];
                } else {
                  log.error(
                    new Date(),
                    "didn't find response object, unable to send data",
                  );
                }
                break;

              case "websocket-connection-closed":
                try {
                  openWebsocketConnections[message.id].socket.close();
                } catch (e) {
                  log.info(
                    new Date(),
                    "error closing websocket connection, probably already closed",
                    message.id,
                    e,
                  );
                }
                break;

              // deno-lint-ignore no-case-declarations
              case "websocket-message":
                const userSocket = openWebsocketConnections[message.id];
                if (userSocket) {
                  log.debug(
                    new Date(),
                    "sending websocket message received from proxied service to client",
                    message.id,
                  );
                  userSocket.socket.send(message.rawData);
                }
                break;
            }
          };

          socket.onclose = () => {
            log.info(new Date(), "connection closed", socketDomain);
            delete domainsToConnections[socketDomain];
          };
        } else {
          const foreignHost = domainsToConnections[requestedDomain];
          if (!foreignHost) {
            log.info(
              new Date(),
              "received a websocket connection attempt for a domain not registered (yet), closing it",
              requestedDomain,
            );
            socket.close();
          } else {
            const connectionId = generateRandomId();
            log.info(
              new Date(),
              "received a websocket connection from a normal client and not a punchmole client, forwarding...",
              connectionId,
              requestedDomain,
            );
            openWebsocketConnections[connectionId] = { socket };
            foreignHost.socket.send(JSON.stringify({
              type: "websocket-connection",
              id: connectionId,
              headers: Object.fromEntries(req.headers.entries()),
              domain: requestedDomain,
              url: url.pathname,
            }));

            socket.onmessage = (event) => {
              log.info(
                new Date(),
                "received data from client websocket connection, forwarding...",
                connectionId,
              );
              foreignHost.socket.send(JSON.stringify({
                type: "websocket-message",
                id: connectionId,
                rawData: event.data,
              }));
            };

            socket.onerror = (error) => {
              log.info(
                new Date(),
                "got error from client websocket connection",
                connectionId,
                error,
              );
              foreignHost.socket.send(JSON.stringify({
                type: "websocket-error",
                id: connectionId,
                error: error,
              }));
            };

            socket.onclose = () => {
              log.info(new Date(), "client websocket closed", connectionId);
              foreignHost.socket.send(JSON.stringify({
                type: "websocket-connection-closed",
                id: connectionId,
              }));
              delete openWebsocketConnections[connectionId];
            };
          }
        }
      };

      return response;
    }

    const foreignHost = domainsToConnections[requestedDomain];
    log.debug(
      new Date(),
      "request started for",
      requestedDomain,
      req.method,
      url.pathname,
    );

    if (foreignHost && foreignHost.status === "alive") {
      log.debug(
        new Date(),
        "-> found endpoint",
        url.pathname,
        Object.fromEntries(req.headers.entries()),
      );
      const requestForward = {
        type: "request-start",
        date: new Date(),
        domain: requestedDomain,
        id: generateRandomId(),
        method: req.method,
        url: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      };

      log.debug(
        new Date(),
        "-> forward to remote client",
        JSON.stringify(requestForward),
      );

      const p = new Promise<Response>((resolve) => {
        openRequests[requestForward.id] = {
          resolve,
          headers: new Headers(),
          body: "",
        };
      });
      foreignHost.socket.send(JSON.stringify(requestForward));

      return p;
    } else {
      return new Response(
        "no registration for domain and/or remote service not available",
        { status: 503 },
      );
    }
  };

  Deno.serve({ port, handler });
  log.info(new Date(), `server is listening on port ${port}`);
}
