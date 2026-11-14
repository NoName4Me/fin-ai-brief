import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createPooledMailTransport } from '../src/server/mail-transport.ts';
import { mailFailure } from '../src/server/mail-errors.ts';

async function smtpServer(dropAfterData = false) {
  const sockets = new Set<Socket>();
  const counts = { connections: 0, authentications: 0, messages: 0 };
  const server = createServer((socket) => {
    counts.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let buffer = '';
    let data = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line !== '.') continue;
          data = false;
          counts.messages++;
          if (dropAfterData) socket.destroy();
          else socket.write('250 accepted\r\n');
        } else if (line.startsWith('EHLO')) {
          socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        } else if (line.startsWith('AUTH PLAIN')) {
          counts.authentications++;
          socket.write('235 authenticated\r\n');
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 send message\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试SMTP服务未启动');
  return {
    counts,
    connection: {
      host: '127.0.0.1',
      port: address.port,
      security: 'none' as const,
      user: 'sender@example.invalid',
      password: 'test-only-password',
      from: 'sender@example.invalid',
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const message = {
  from: 'sender@example.invalid',
  to: 'reader@example.invalid',
  text: 'Local SMTP test',
};

test('真实SMTP连续发送两封邮件只连接和认证一次', { timeout: 10_000 }, async () => {
  const server = await smtpServer();
  const transport = createPooledMailTransport(server.connection);
  try {
    await transport.sendMail(message);
    await transport.sendMail(message);
    assert.deepEqual(server.counts, { connections: 1, authentications: 1, messages: 2 });
  } finally {
    transport.close();
    await server.close();
  }
});

test('正文提交后断线不会由连接池自动重发，保留结果不明状态', { timeout: 10_000 }, async () => {
  const server = await smtpServer(true);
  const transport = createPooledMailTransport(server.connection);
  try {
    await assert.rejects(transport.sendMail(message), (error) => {
      assert.equal(mailFailure(error).state, 'uncertain', JSON.stringify(error));
      return true;
    });
    assert.deepEqual(server.counts, { connections: 1, authentications: 1, messages: 1 });
  } finally {
    transport.close();
    await server.close();
  }
});
