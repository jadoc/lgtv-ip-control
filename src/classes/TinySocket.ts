import assert from 'assert';
import { createSocket } from 'dgram';
import { isIP, isIPv6, Socket } from 'net';

import { DefaultSettings } from '../constants/DefaultSettings.js';

export interface SocketSettings {
  networkPort: number;
  networkTimeout: number;
  networkWolAddress: string;
  networkWolPort: number;
}

const MacAddressMatcher = /^([0-9a-f]{2}:){5}([0-9a-f]{2})$/i;
const MacAddressBlockSeparator = ':';
const MacAddressBlocksCount = 6;
const WolMacAddressCount = 16;
const WolSyncByte = 0xff;
const WolSyncCount = 6;

function assertSettings(settings: SocketSettings) {
  assert(
    typeof settings === 'object' && settings !== null,
    'settings must be an object',
  );

  const { networkPort, networkTimeout, networkWolAddress, networkWolPort } =
    settings;
  assert(
    typeof networkPort === 'number' && networkPort > 0,
    'settings.networkPort must be a number greater than 0',
  );
  assert(
    typeof networkTimeout === 'number' && networkTimeout > 0,
    'settings.networkTimeout must be a number greater than 0',
  );
  assert(
    typeof networkWolAddress === 'string' && networkWolAddress.length > 0,
    'settings.networkWolAddress must be a string with length greater than 0',
  );
  assert(
    isIP(networkWolAddress),
    'settings.networkWolAddress must be a valid IPv4 or IPv6',
  );
  assert(
    typeof networkWolPort === 'number' && networkWolPort > 0,
    'settings.networkWolPort must be a number greater than 0',
  );
}

export class TimeoutError extends Error {}

export class TinySocket {
  private client = new Socket();

  constructor(
    private host: string,
    private macAddress: string | null,
    private settings = DefaultSettings,
  ) {
    assertSettings(settings);
    assert(
      macAddress === null || MacAddressMatcher.test(macAddress),
      'invalid mac address',
    );
  }

  wrap<T>(
    method: (
      resolve: (value: T) => void,
      reject: (error: Error) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const handleTimeout = () => {
        this.client.end();
        reject(new TimeoutError());
      };
      const cleanup = () => {
        this.client.removeListener('error', reject);
        this.client.removeListener('timeout', handleTimeout);
      };

      this.client.once('error', reject);
      this.client.once('timeout', handleTimeout);

      method(
        (value: T) => {
          cleanup();
          resolve(value);
        },
        (error: Error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  connect(): Promise<void> {
    return this.wrap((resolve) => {
      this.client.setTimeout(this.settings.networkTimeout);
      this.client.connect(this.settings.networkPort, this.host, resolve);
    });
  }

  read(): Promise<Buffer> {
    return this.wrap((resolve) => {
      this.client.once('data', resolve);
    });
  }

  write(data: Buffer): Promise<void> {
    return this.wrap((resolve, reject) => {
      this.client.write(data, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async sendReceive(data: Buffer): Promise<Buffer> {
    await this.write(data);
    return this.read();
  }

  disconnect(): Promise<void> {
    return this.wrap((resolve) => {
      this.client.end(resolve);
    });
  }

  wakeOnLan() {
    if (!this.macAddress) {
      throw new Error('Unable to wake on lan: mac address was not configured');
    }
    const socket = createSocket(
      isIPv6(this.settings.networkWolAddress) ? 'udp6' : 'udp4',
    );
    socket.on('error', socket.close);
    socket.on('listening', () => {
      socket.setBroadcast(true);
    });

    const magicPacket = Buffer.alloc(
      WolSyncCount + MacAddressBlocksCount * WolMacAddressCount,
      WolSyncByte,
    );
    const macAddressBlocks = this.macAddress
      .split(MacAddressBlockSeparator)
      .map((string) => parseInt(string, 16));
    for (let i = 0; i < WolMacAddressCount; i++) {
      for (let j = 0; j < macAddressBlocks.length; j++) {
        const index = WolSyncCount + i * MacAddressBlocksCount + j;
        magicPacket[index] = macAddressBlocks[j];
      }
    }

    socket.send(
      magicPacket,
      0,
      magicPacket.length,
      this.settings.networkWolPort,
      this.settings.networkWolAddress,
      () => {
        socket.close();
      },
    );
  }
}
