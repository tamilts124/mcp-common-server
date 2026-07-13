"use strict";

const modbusClientSchema = {
  name: "modbus_client",
  description: "Zero-dependency Modbus TCP client (pure Node.js net; no npm deps). Implements Modbus TCP with MBAP framing per IEC 61158 / MODBUS Application Protocol v1.1b3. Connects to PLCs, sensors, SCADA gateways, RTUs, and any Modbus TCP-capable device. Supports all standard read/write function codes: FC01 (Read Coils), FC02 (Read Discrete Inputs), FC03 (Read Holding Registers), FC04 (Read Input Registers), FC05 (Write Single Coil), FC06 (Write Single Register), FC15 (Write Multiple Coils), FC16 (Write Multiple Registers). Modbus exceptions are decoded to human-readable messages. Security: NUL-byte guard on host; timeout clamped 500ms-30s; unit_id/address/quantity validated per spec. Modbus has no built-in auth; apply network-layer access control.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "read_coils",
          "read_discrete_inputs",
          "read_holding_registers",
          "read_input_registers",
          "write_coil",
          "write_register",
          "write_multiple_coils",
          "write_multiple_registers",
          "info",
        ],
        description: "Operation to perform. read_coils=FC01, read_discrete_inputs=FC02, read_holding_registers=FC03, read_input_registers=FC04, write_coil=FC05, write_register=FC06, write_multiple_coils=FC15, write_multiple_registers=FC16, info=show config without connecting.",
      },
      host: {
        type: "string",
        description: "Hostname or IP address of the Modbus TCP device (default: '127.0.0.1').",
      },
      port: {
        type: "number",
        description: "TCP port of the Modbus server (default: 502, the standard Modbus TCP port).",
      },
      unit_id: {
        type: "number",
        description: "Modbus Unit ID (slave address), 0-255. For direct TCP devices use 1 (default); for Modbus TCP gateways routing to serial devices, set the downstream slave ID (1-247). Use 255 for broadcast (if the device supports it).",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (default: 5000, range: 500-30000).",
      },
      address: {
        type: "number",
        description: "Starting register/coil address (0-65535). Modbus uses 0-based protocol addresses. Note: some device docs use 1-based addresses (Modbus 100001 maps to protocol address 0).",
      },
      quantity: {
        type: "number",
        description: "Number of coils/registers to read. Max: 2000 for coils/discrete inputs, 125 for holding/input registers. Required for read operations.",
      },
      value: {
        type: ["boolean", "number"],
        description: "Value to write. For write_coil: boolean (true=ON/0xFF00, false=OFF/0x0000). For write_register: integer -32768 to 65535 (signed or unsigned 16-bit).",
      },
      values: {
        type: "array",
        description: "Array of values to write. For write_multiple_coils: array of booleans (max 1968). For write_multiple_registers: array of integers -32768 to 65535 (max 123).",
        items: { type: ["boolean", "number"] },
      },
      signed: {
        type: "boolean",
        description: "If true, interpret 16-bit register values as signed integers (-32768 to 32767) instead of unsigned (0 to 65535). Only applies to read_holding_registers and read_input_registers (default: false).",
      },
    },
  },
};

module.exports = { modbusClientSchema };
