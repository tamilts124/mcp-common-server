"use strict";
// -- UTILITY TOOL SCHEMAS -- part 31 ------------------------------------------
// Added: ftp_client (v4.170.0).

const UTIL_SCHEMAS_31 = [
  {
    name: "ftp_client",
    description:
      "Zero-dependency FTP/FTPS client -- pure Node.js net/tls, no npm deps.\n\n" +
      "Implements RFC 959 (FTP) with RFC 4217 (Explicit FTPS via AUTH TLS).\n\n" +
      "Compatible with: vsftpd, ProFTPD, FileZilla Server, IIS FTP, Pure-FTPd,\n" +
      "WinSCP FTP, FileZilla, AWS Transfer Family, Azure Blob FTP.\n\n" +
      "Operations:\n" +
      "  list   -- List directory contents (parses Unix and DOS-style output)\n" +
      "  get    -- Download a file (returns base64 or utf8 data)\n" +
      "  put    -- Upload a file (accepts base64 or utf8 data)\n" +
      "  delete -- Delete a remote file (DELE)\n" +
      "  rename -- Rename/move a remote file (RNFR/RNTO)\n" +
      "  mkdir  -- Create a remote directory (MKD)\n" +
      "  rmdir  -- Remove a remote directory (RMD)\n" +
      "  pwd    -- Print current working directory (PWD)\n" +
      "  stat   -- Get file size and modification time (SIZE + MDTM)\n" +
      "  quit   -- Gracefully close the connection (QUIT)\n\n" +
      "All data transfers use passive mode (PASV / EPSV) for NAT/firewall compatibility.\n\n" +
      "Connection options:\n" +
      "  host, port (default 21), ftps (Explicit FTPS via AUTH TLS), reject_unauthorized\n" +
      "  username / password (default: anonymous / anonymous@)\n" +
      "  timeout (default 30s), connect_timeout\n" +
      "  binary (default true for binary mode; false for ASCII/text mode)\n\n" +
      "Security guards:\n" +
      "  NUL and CRLF injection guards on all path/filename/username/password fields\n" +
      "  Max path length: 4096 chars\n" +
      "  Download cap: 50 MB; Upload cap: 100 MB; Listing cap: 4 MB\n" +
      "  Credentials never included in result objects\n\n" +
      "Returns { host, port, operation, elapsedMs, banner, ...op-specific fields }.\n" +
      "Always available -- does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "FTP server hostname or IP address.",
        },
        port: {
          type: "number",
          description: "FTP server port (default: 21).",
        },
        ftps: {
          type: "boolean",
          description: "Use Explicit FTPS (AUTH TLS upgrade). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed FTPS certificates (default: true).",
        },
        username: {
          type: "string",
          description: "FTP username (default: 'anonymous').",
        },
        password: {
          type: "string",
          description: "FTP password (default: 'anonymous@'). Never returned in results.",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout, 10)).",
        },
        operation: {
          type: "string",
          enum: ["list", "get", "put", "delete", "rename", "mkdir", "rmdir", "pwd", "stat", "quit"],
          description:
            "FTP operation to perform: list (directory listing), get (download), " +
            "put (upload), delete (remove file), rename (rename/move), mkdir (create dir), " +
            "rmdir (remove dir), pwd (current directory), stat (file size + mtime), quit (close).",
        },
        path: {
          type: "string",
          description: "Remote file or directory path. Required for: get, put, delete, rename, mkdir, rmdir, stat. Optional for: list (defaults to current directory).",
        },
        new_name: {
          type: "string",
          description: "New path/name for rename operation (RNTO argument). Required for: rename.",
        },
        data: {
          type: "string",
          description: "File content to upload, base64-encoded by default (or utf8 if encoding='utf8'). Required for: put.",
        },
        encoding: {
          type: "string",
          enum: ["base64", "utf8", "text"],
          description: "Encoding for 'data' (put) and response data (get). Default: 'base64'.",
        },
        binary: {
          type: "boolean",
          description: "Use binary transfer mode (TYPE I). Default: true. Set false for text/ASCII files.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_31 };
