let mcp = await import("./mcplite.js");
let client = new mcp.MCPClient("http://localhost:8080");
await client.connect();
const tools = await client.listTools();
console.log(`Found ${tools.length} tools`);
const result = await client.callTool("add", {a: 33, b: 55}, false);
console.log(result);
