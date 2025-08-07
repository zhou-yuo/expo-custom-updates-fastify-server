import { FastifyRequest, FastifyReply, FastifyPluginAsync } from 'fastify';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import mime from 'mime';
import nullthrows from 'nullthrows';
import { getLatestUpdateBundlePathForRuntimeVersionAsync, getMetadataAsync } from '../../../common/helpers';

// 为查询参数定义类型
interface AssetsQuery {
  asset: string;
  runtimeVersion: string;
  platform: 'ios' | 'android';
}

const assets: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get('/', async (request: FastifyRequest<{ Querystring: AssetsQuery }>, reply: FastifyReply) => {
    // 1. 从 request.query 获取参数
    const { asset: assetName, runtimeVersion, platform } = request.query;

    // 2. 验证逻辑保持不变
    if (!assetName) {
      // 3. 使用 reply.code().send() 替代 res.statusCode + res.json()
      return reply.code(400).send({ error: 'No asset name provided.' });
    }
    // ... 其他验证 ...
    if (platform !== 'ios' && platform !== 'android') {
      return reply.code(400).send({ error: 'No platform provided. Expected "ios" or "android".' });
    }

    if (!runtimeVersion || typeof runtimeVersion !== 'string') {
      return reply.code(400).send({ error: 'No runtimeVersion provided.' });
    }

    try {
      // 4. 所有业务逻辑 (读取文件、获取元数据) 完全复用
      const updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
      const { metadataJson } = await getMetadataAsync({ updateBundlePath, runtimeVersion });
      const assetPath = path.resolve(assetName);
      
      if (!fsSync.existsSync(assetPath)) {
        return reply.code(404).send({ error: `Asset "${assetName}" does not exist.` });
      }

      const asset = await fs.readFile(assetPath, null);
      const assetMetadata = metadataJson.fileMetadata[platform].assets.find(
        (asset: any) => asset.path === assetName.replace(`${updateBundlePath}/`, '')
      );
      const isLaunchAsset = metadataJson.fileMetadata[platform].bundle === assetName.replace(`${updateBundlePath}/`, '');

      // 5. 使用 reply.header().send() 替代 res.setHeader() + res.end()
      const contentType = isLaunchAsset ? 'application/javascript' : nullthrows(mime.getType(assetMetadata.ext));
      reply.header('content-type', contentType);
      return reply.send(asset);

    } catch (error: any) {
      fastify.log.error(error); // Fastify 内置了日志记录器
      return reply.code(500).send({ error: error.message || error });
    }
  }
);

}

export default assets;
