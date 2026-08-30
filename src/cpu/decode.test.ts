/*
 * Copyright 2026 Raymond Lam
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import decode from '#cpu/decode.js';
import { createMemory, loadBytes, storeBytes } from '#memory.js';
import {
  createRegisters,
  readControlAndStatusRegister,
  readGeneralPurposeRegister,
  readProgramCounter,
  writeControlAndStatusRegister,
  writeGeneralPurposeRegister,
} from '#cpu/registers.js';
import { bytesToNumber, signedNumberToBytes } from '#utils/bytes.js';

/** Pack a 32-bit instruction encoding as little-endian bytes. */
const instructionBytes = (encoding: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  bytes[0] = encoding & 0xff;
  bytes[1] = (encoding >>> 8) & 0xff;
  bytes[2] = (encoding >>> 16) & 0xff;
  bytes[3] = (encoding >>> 24) & 0xff;
  return bytes;
};

describe('decode + execute', () => {
  it('executes addi x1, x0, 42 and advances pc', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    // addi x1, x0, 42
    decode(instructionBytes(0x02a00093))(registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(42, 32));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes csrrw x1, 0x300, x2 and advances pc', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(0x22, 32));
    writeControlAndStatusRegister(registers, 0x300, signedNumberToBytes(0x11, 32));
    // csrrw x1, 0x300, x2
    decode(instructionBytes(0x300110f3))(registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(0x11, 32));
    assert.deepEqual(readControlAndStatusRegister(registers, 0x300), signedNumberToBytes(0x22, 32));
    assert.equal(bytesToNumber(readProgramCounter(registers)), 4);
  });

  it('executes csrrwi x1, 0x300, 31 as a zero-extended immediate', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    // csrrwi x1, 0x300, 31
    decode(instructionBytes(0x300fd0f3))(registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(0, 32));
    assert.deepEqual(readControlAndStatusRegister(registers, 0x300), signedNumberToBytes(31, 32));
  });

  it('executes lui x1, 0x12345', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    // lui x1, 0x12345
    decode(instructionBytes(0x123450b7))(registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(0x12345000, 32));
  });

  it('executes sw then lw round-trip', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    writeGeneralPurposeRegister(registers, 1, signedNumberToBytes(0xaabbccdd, 32));
    writeGeneralPurposeRegister(registers, 2, signedNumberToBytes(16, 32));

    // sw x1, 0(x2)
    decode(instructionBytes(0x00112023))(registers, memory);
    const stored = new Uint8Array(4);
    loadBytes({ destination: stored, memory, address: 16, byteLength: 4 });
    assert.deepEqual(stored, new Uint8Array([0xdd, 0xcc, 0xbb, 0xaa]));

    // lw x3, 0(x2)
    decode(instructionBytes(0x00012183))(registers, memory);
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(0xaabbccdd, 32));
  });

  it('executes the sample program through the DONE mailbox store', () => {
    const registers = createRegisters();
    const memory = createMemory(64);
    storeBytes({
      memory,
      address: 0,
      source: Uint8Array.of(
        0x93,
        0x00,
        0xa0,
        0x02, // addi x1, x0, 42
        0x13,
        0x01,
        0xc0,
        0x03, // addi x2, x0, 60
        0x93,
        0x01,
        0x10,
        0x00, // addi x3, x0, 1
        0x23,
        0x20,
        0x31,
        0x00 // sw x3, 0(x2)
      ),
      byteLength: 16,
    });

    for (let step = 0; step < 4; step += 1) {
      const word = new Uint8Array(4);
      loadBytes({
        destination: word,
        memory,
        address: bytesToNumber(readProgramCounter(registers)),
        byteLength: 4,
      });
      decode(word)(registers, memory);
    }

    assert.deepEqual(readGeneralPurposeRegister(registers, 1), signedNumberToBytes(42, 32));
    assert.deepEqual(readGeneralPurposeRegister(registers, 2), signedNumberToBytes(60, 32));
    assert.deepEqual(readGeneralPurposeRegister(registers, 3), signedNumberToBytes(1, 32));
    assert.equal(memory[60], 1);
  });
});
