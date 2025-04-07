export class MCPClient {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.eventSource = null;
        this.messageHandlers = new Map();
        this.nextRequestId = 1;
        this.connected = false;
        this.capabilities = {
            experimental: {}
        };
        this.clientInfo = {
            name: "MCPLite",
            version: "0.1.0"
        };
        this.eventListeners = new Map();
        this.serverCapabilities = null;
    }

    on(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }

        this.eventListeners.get(event).push(callback);
    }

    emit(event, data) {
        if (!this.eventListeners || !this.eventListeners.has(event)) {
            return;
        }

        for (const callback of this.eventListeners.get(event)) {
            callback(data);
        }
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.eventSource = new EventSource(`${this.serverUrl}/sse`);
                let messageEndpoint = null;

                this.eventSource.addEventListener('endpoint', (event) => {
                    messageEndpoint = event.data;
                    console.log("Message endpoint:", messageEndpoint);
                    this.messageEndpoint = messageEndpoint;

                    this.initialize().then(result => {
                        this.serverCapabilities = result.capabilities;
                        this.emit('connect', result);
                        resolve(result);
                    }).catch(error => {
                        this.emit('error', error);
                        reject(error);
                    });
                });

                this.eventSource.addEventListener('message', (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleIncomingMessage(message);
                    } catch (error) {
                        console.error("Error parsing message:", error);
                    }
                });

                this.eventSource.onerror = (error) => {
                    console.error("SSE connection error:", error);
                    this.emit('error', error);
                    reject(error);
                };
            } catch (error) {
                console.error("Failed to connect:", error);
                this.emit('error', error);
                reject(error);
            }
        });
    }

    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
            this.connected = false;
            console.log("Disconnected from MCP server");
            this.emit('disconnect');
        }
    }

    async initialize() {
        const initializeResult = await this.sendRequest({
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: this.capabilities,
                clientInfo: this.clientInfo
            }
        });

        console.log("Server info:", initializeResult.serverInfo);
        console.log("Server capabilities:", initializeResult.capabilities);

        this.sendNotification({
            method: "notifications/initialized"
        });

        this.connected = true;

        return initializeResult;
    }

    async listTools() {
        if (!this.connected) {
            throw new Error("Not connected to MCP server");
        }

        const result = await this.sendRequest({
            method: "tools/list"
        });

        return result.tools;
    }

    async callTool(name, args = {}, withProgress = true) {
        if (!this.connected) {
            throw new Error("Not connected to MCP server");
        }

        const params = {
            name: name,
            arguments: args
        };

        if (withProgress) {
            const progressToken = Date.now().toString();
            params._meta = {
                progressToken: progressToken
            };
        }

        const result = await this.sendRequest({
            method: "tools/call",
            params: params
        });

        return result;
    }

    async sendRequest(request, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const id = this.nextRequestId++;
            const jsonRpcRequest = {
                jsonrpc: "2.0",
                id: id,
                method: request.method,
                params: request.params || {}
            };

            const timeoutId = setTimeout(() => {
                this.messageHandlers.delete(id);
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            this.messageHandlers.set(id, (response) => {
                clearTimeout(timeoutId);

                if (response.error) {
                    reject(new Error(`Error ${response.error.code}: ${response.error.message}`));
                } else {
                    resolve(response.result);
                }
            });

            this.sendMessage(jsonRpcRequest).catch(error => {
                clearTimeout(timeoutId);
                this.messageHandlers.delete(id);
                reject(error);
            });
        });
    }

    async sendNotification(notification) {
        const jsonRpcNotification = {
            jsonrpc: "2.0",
            method: notification.method,
            params: notification.params || {}
        };

        await this.sendMessage(jsonRpcNotification);
    }

    async sendMessage(message) {
        try {
            const endpoint = this.messageEndpoint || `${this.serverUrl}/message`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
            });

            if (!response.ok) {
                const error = new Error(`HTTP error: ${response.status} ${response.statusText}`);
                error.status = response.status;
                throw error;
            }
        } catch (error) {
            console.error("Error sending message:", error);
            throw error;
        }
    }

    handleIncomingMessage(message) {
        if (Array.isArray(message)) {
            message.forEach(msg => this.handleIncomingMessage(msg));

            return;
        }

        if (message.method && !message.id) {
            this.handleNotification(message);

            return;
        }

        if (message.id && (message.result || message.error)) {
            const handler = this.messageHandlers.get(message.id);

            if (handler) {
                handler(message);
                this.messageHandlers.delete(message.id);
            } else {
                console.warn("Received response for unknown request ID:", message.id);
            }

            return;
        }

        if (message.method && message.id) {
            this.handleServerRequest(message);

            return;
        }

        console.warn("Unhandled message:", message);
    }

    handleNotification(notification) {
        switch (notification.method) {
            case "notifications/resources/list_changed":
                console.log("Resource list changed");
                this.emit('resourceListChanged');
                break;
            case "notifications/resources/updated":
                console.log(`Resource updated: ${notification.params.uri}`);
                this.emit('resourceUpdated', notification.params);
                break;
            case "notifications/tools/list_changed":
                console.log("Tool list changed");
                this.emit('toolListChanged');
                break;
            case "notifications/prompts/list_changed":
                console.log("Prompt list changed");
                this.emit('promptListChanged');
                break;
            case "notifications/progress":
                console.log(`Progress: ${notification.params.progress}/${notification.params.total || "?"} - ${notification.params.message || ""}`);
                this.emit('progress', {
                    token: notification.params.progressToken,
                    progress: notification.params.progress,
                    total: notification.params.total,
                    message: notification.params.message
                });
                break;
            case "notifications/message":
                console.log(`Server message [${notification.params.level}]:`, notification.params.data);
                this.emit('message', {
                    level: notification.params.level,
                    data: notification.params.data
                });
                break;
            default:
                console.log("Received notification:", notification.method);
        }
    }

    handleServerRequest(request) {
        switch (request.method) {
            case "ping":
                this.sendMessage({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {}
                });
                break;
            case "sampling/createMessage":
                console.log("Server requested LLM sampling:", request);
                this.emit('samplingRequest', request);
                break;
            case "roots/list":
                console.log("Server requested roots list");
                this.emit('rootsListRequest', request);
                this.sendMessage({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        roots: [] // Populate with actual roots
                    }
                });
                break;
            default:
                console.warn(`Unsupported server request method: ${request.method}`);
                this.sendMessage({
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: -32601,
                        message: "Method not found"
                    }
                });
        }
    }
}
