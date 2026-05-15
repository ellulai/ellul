export const FrameType = {
  HELLO: 0x01,
  REQUEST: 0x02,
  REQ_BODY: 0x03,
  REQ_END: 0x04,
  RESPONSE: 0x05,
  RES_BODY: 0x06,
  RES_END: 0x07,
  WS_DATA: 0x08,
  WS_CLOSE: 0x09,
  ERROR: 0x0a,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const HEADER = 9;

export function encodeFrame(type: FrameType, id: number, payload: Buffer): Buffer {
  const buf = Buffer.allocUnsafe(HEADER + payload.length);
  buf[0] = type;
  buf.writeUInt32BE(id, 1);
  buf.writeUInt32BE(payload.length, 5);
  payload.copy(buf, HEADER);
  return buf;
}

export function decodeFrame(data: Buffer): { type: FrameType; id: number; payload: Buffer } {
  if (data.length < HEADER) throw new Error("Frame too short");
  const type = data[0] as FrameType;
  const id = data.readUInt32BE(1);
  const len = data.readUInt32BE(5);
  if (data.length < HEADER + len) throw new Error("Frame truncated");
  return { type, id, payload: data.subarray(HEADER, HEADER + len) };
}
