import { FastifyRequest, FastifyReply, FastifyPluginAsync } from "fastify";
import fs from "fs/promises";
import {
  getAssetMetadataAsync,
  getMetadataAsync,
  convertSHA256HashToUUID,
  convertToDictionaryItemsRepresentation,
  signRSASHA256,
  getPrivateKeyAsync,
  getExpoConfigAsync,
  getLatestUpdateBundlePathForRuntimeVersionAsync,
  createRollBackDirectiveAsync,
  NoUpdateAvailableError,
  createNoUpdateAvailableDirectiveAsync,
} from "../../../common/helpers";

import { serializeDictionary } from "structured-headers";
import FormData from "form-data";

const manifest: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get(
    "/",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        // 1. 从 request.headers 和 request.query 获取参数
        const protocolVersionMaybeArray = request.headers[
          "expo-protocol-version"
        ] as string | string[] | undefined;
        console.log(`expo-protocol-version ${protocolVersionMaybeArray}`);
        if (
          protocolVersionMaybeArray &&
          Array.isArray(protocolVersionMaybeArray)
        ) {
          return reply.code(400).send({
            error: `Unsupported protocol version. Expected either 0 or 1.`,
          });
        }
        const protocolVersion = parseInt(protocolVersionMaybeArray ?? "0", 10);

        const platform = (request.headers["expo-platform"] ??
          (request.query as any)["platform"]) as string;
        console.log(`platform ${platform}`);
        if (platform !== "ios" && platform !== "android") {
          return reply.code(400).send({
            error: `Unsupported platform. Expected either ios or android.`,
          });
        }

        const runtimeVersion = (request.headers["expo-runtime-version"] ??
          (request.query as any)["runtime-version"]) as string;
        console.log(`runtime-version ${runtimeVersion}`);
        if (!runtimeVersion || typeof runtimeVersion !== "string") {
          return reply.code(400).send({ error: `No runtimeVersion provided.` });
        }

        try {
          // 2. 所有业务逻辑完全复用
          const updateBundlePath =
            await getLatestUpdateBundlePathForRuntimeVersionAsync(
              runtimeVersion
            );
          const updateType = await getTypeOfUpdateAsync(updateBundlePath); // 假设此函数也已迁移

          if (updateType === UpdateType.NORMAL_UPDATE) {
            // 3. 调用我们适配过的函数
            await putUpdateInResponseAsync(
              request,
              reply,
              updateBundlePath,
              runtimeVersion,
              platform,
              protocolVersion
            );
          } else {
            // ... 处理回滚等情况
            await putRollBackInResponseAsync(
              request,
              reply,
              updateBundlePath,
              protocolVersion
            );
          }
        } catch (maybeNoUpdateAvailableError) {
          if (maybeNoUpdateAvailableError instanceof NoUpdateAvailableError) {
            await putNoUpdateAvailableInResponseAsync(
              request,
              reply,
              protocolVersion
            );
            return;
          }
          throw maybeNoUpdateAvailableError;
        }
      } catch (e) {
        return reply
        .code(505)
        .send({
          error: `${e}`,
        });
      }
    }
  );
};

enum UpdateType {
  NORMAL_UPDATE,
  ROLLBACK,
}

// 获取异步更新类型
async function getTypeOfUpdateAsync(
  updateBundlePath: string
): Promise<UpdateType> {
  const directoryContents = await fs.readdir(updateBundlePath);
  return directoryContents.includes("rollback")
    ? UpdateType.ROLLBACK
    : UpdateType.NORMAL_UPDATE;
}

// 将更新作为异步响应
async function putUpdateInResponseAsync(
  request: FastifyRequest, // <-- 使用 FastifyRequest
  reply: FastifyReply, // <-- 使用 FastifyReply
  updateBundlePath: string,
  runtimeVersion: string,
  platform: string,
  protocolVersion: number
): Promise<void> {
  const currentUpdateId = request.headers["expo-current-update-id"];
  const { metadataJson, createdAt, id } = await getMetadataAsync({
    updateBundlePath,
    runtimeVersion,
  });

  // NoUpdateAvailable directive only supported on protocol version 1
  // for protocol version 0, serve most recent update as normal
  if (
    currentUpdateId === convertSHA256HashToUUID(id) &&
    protocolVersion === 1
  ) {
    throw new NoUpdateAvailableError();
  }

  const expoConfig = await getExpoConfigAsync({
    updateBundlePath,
    runtimeVersion,
  });
  const platformSpecificMetadata = metadataJson.fileMetadata[platform];
  const manifest = {
    id: convertSHA256HashToUUID(id),
    createdAt,
    runtimeVersion,
    assets: await Promise.all(
      (platformSpecificMetadata.assets as any[]).map((asset: any) =>
        getAssetMetadataAsync({
          updateBundlePath,
          filePath: asset.path,
          ext: asset.ext,
          runtimeVersion,
          platform,
          isLaunchAsset: false,
        })
      )
    ),
    launchAsset: await getAssetMetadataAsync({
      updateBundlePath,
      filePath: platformSpecificMetadata.bundle,
      isLaunchAsset: true,
      runtimeVersion,
      platform,
      ext: null,
    }),
    metadata: {},
    extra: {
      expoClient: expoConfig,
    },
  };

  let signature = null;
  const expectSignatureHeader = request.headers["expo-expect-signature"];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      return reply
        .code(400)
        .send({
          error: `Code signing requested but no key supplied when starting server.`,
        });
    }
    const manifestString = JSON.stringify(manifest);
    const hashSignature = signRSASHA256(manifestString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: "main",
    });
    signature = serializeDictionary(dictionary);
  }

  const assetRequestHeaders: { [key: string]: object } = {};
  [...manifest.assets, manifest.launchAsset].forEach((asset) => {
    assetRequestHeaders[asset.key] = {
      "test-header": "test-header-value",
    };
  });

  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest), {
    contentType: "application/json",
    header: {
      "content-type": "application/json; charset=utf-8",
      ...(signature ? { "expo-signature": signature } : {}),
    },
  });
  form.append("extensions", JSON.stringify({ assetRequestHeaders }), {
    contentType: "application/json",
  });

  // 关键区别在这里：
  reply
    .code(200)
    .header("expo-protocol-version", protocolVersion)
    .header("expo-sfv-version", 0)
    .header("cache-control", "private, max-age=0")
    .header("content-type", `multipart/mixed; boundary=${form.getBoundary()}`);

  // Fastify 的 .send() 可以直接处理 Buffer，更简洁
  reply.send(form.getBuffer());
}

// 将回滚作为异步响应
async function putRollBackInResponseAsync(
  request: FastifyRequest, // <-- 使用 FastifyRequest
  reply: FastifyReply, // <-- 使用 FastifyReply
  updateBundlePath: string,
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    throw new Error("Rollbacks not supported on protocol version 0");
  }

  const embeddedUpdateId = request.headers["expo-embedded-update-id"];
  if (!embeddedUpdateId || typeof embeddedUpdateId !== "string") {
    throw new Error(
      "Invalid Expo-Embedded-Update-ID request header specified."
    );
  }

  const currentUpdateId = request.headers["expo-current-update-id"];
  if (currentUpdateId === embeddedUpdateId) {
    throw new NoUpdateAvailableError();
  }

  // 创建同步回滚指令
  const directive = await createRollBackDirectiveAsync(updateBundlePath);

  let signature = null;
  const expectSignatureHeader = request.headers["expo-expect-signature"];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      return reply
        .code(400)
        .send({
          error: `Code signing requested but no key supplied when starting server.`,
        });
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = signRSASHA256(directiveString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: "main",
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append("directive", JSON.stringify(directive), {
    contentType: "application/json",
    header: {
      "content-type": "application/json; charset=utf-8",
      ...(signature ? { "expo-signature": signature } : {}),
    },
  });

  reply
    .code(200)
    .header("expo-protocol-version", 1)
    .header("expo-sfv-version", 0)
    .header("cache-control", "private, max-age=0")
    .header("content-type", `multipart/mixed; boundary=${form.getBoundary()}`);

  // Fastify 的 .send() 可以直接处理 Buffer，更简洁
  reply.send(form.getBuffer());
}

async function putNoUpdateAvailableInResponseAsync(
  request: FastifyRequest, // <-- 使用 FastifyRequest
  reply: FastifyReply, // <-- 使用 FastifyReply
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    throw new Error(
      "NoUpdateAvailable directive not available in protocol version 0"
    );
  }

  const directive = await createNoUpdateAvailableDirectiveAsync();

  let signature = null;
  const expectSignatureHeader = request.headers["expo-expect-signature"];
  if (expectSignatureHeader) {
    const privateKey = await getPrivateKeyAsync();
    if (!privateKey) {
      return reply
        .code(400)
        .send({
          error: `Code signing requested but no key supplied when starting server`,
        });
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = signRSASHA256(directiveString, privateKey);
    const dictionary = convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: "main",
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append("directive", JSON.stringify(directive), {
    contentType: "application/json",
    header: {
      "content-type": "application/json; charset=utf-8",
      ...(signature ? { "expo-signature": signature } : {}),
    },
  });

  reply
    .code(200)
    .header("expo-protocol-version", 1)
    .header("expo-sfv-version", 0)
    .header("cache-control", "private, max-age=0")
    .header("content-type", `multipart/mixed; boundary=${form.getBoundary()}`);

  // Fastify 的 .send() 可以直接处理 Buffer，更简洁
  reply.send(form.getBuffer());
}

export default manifest;
