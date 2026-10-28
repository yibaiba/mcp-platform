"""Real Python MCP SDK fixture used by container integration acceptance."""
import os
import sys
from mcp.server.fastmcp import FastMCP

server = FastMCP("python-runtime-acceptance")


@server.tool()
def runtime_identity(message: str) -> dict:
    return {"message": message, "python": sys.version.split()[0], "uid": os.getuid()}


if __name__ == "__main__":
    server.run(transport="stdio")
