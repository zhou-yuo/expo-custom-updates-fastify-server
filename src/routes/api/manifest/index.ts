// src/routes/api/manifest/index.ts
import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import fs from 'fs/promises';

const manifestRoute: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  // fastify-cli 的 autoload 会将此文件的路由前缀设置为 /api/manifest
  // 所以我们在这里只需要定义根路径 '/'
  fastify.get('/', async function (request, reply) {
    fastify.log.info(`manifestRoute --------------- start`);

    try {
      const platform = request.headers['expo-platform'] as string | undefined;
      fastify.log.info(`platform: ${platform}`);

      const runtimeVersion = request.headers['expo-runtime-version'] as string | undefined;
      fastify.log.info(`runtimeVersion: ${runtimeVersion}`);

      if (!platform || !runtimeVersion) {
        // 使用 400 Bad Request 更为合适
        return reply.code(400).send({ error: 'Missing expo-platform or expo-runtime-version header' });
      }

      fastify.log.info(`__dirname: ${__dirname}`);


      // 路径相对于项目根目录
      const updatesDirectory = path.join(__dirname, '..', '..', '..', 'updates', runtimeVersion, platform);
      const manifestPath = path.join(updatesDirectory, 'manifest.json');

      fastify.log.info(`updatesDirectory: ${updatesDirectory}`);

      try {
        await fs.access(manifestPath);
      } catch (error) {
        fastify.log.warn(`Manifest not found at: ${manifestPath}`);
        return reply.code(404).send({ error: 'Manifest not found for the given runtime version and platform.' });
      }

      const manifest = await fs.readFile(manifestPath, 'utf-8');
      
      // Fastify 会自动将 JSON 对象序列化并设置正确的 Content-Type
      // 所以我们直接发送解析后的对象即可
      return JSON.parse(manifest);

    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'An unexpected error occurred.' });
    }
  });
};

export default manifestRoute;