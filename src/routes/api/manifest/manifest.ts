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
        // 从 request.headers 和 request.query 获取参数
        const protocolVersionMaybeArray = request.headers[
          "expo-protocol-version"
        ] as string | string[] | undefined;
        if (
          protocolVersionMaybeArray &&
          Array.isArray(protocolVersionMaybeArray)
        ) {
          return reply.code(400).send({
            error: `Unsupported protocol version. Expected either 0 or 1.`,
          });
        }
        // protocolVersion 参数用于指定和协商客户端（您的 App）与更新服务器之间通信所使用的 Expo Updates 协议的版本。这确保了客户端和服务器能够相互理解对方发送的数据格式和规则。
        // 兼容旧版本的客户端，目前该协议的版本主要有 0 和 1，默认 1。
        const protocolVersion = parseInt(protocolVersionMaybeArray ?? "0", 10);

        const platform = (request.headers["expo-platform"] ??
          (request.query as any)["platform"]) as string;
        if (platform !== "ios" && platform !== "android") {
          return reply.code(400).send({
            error: `Unsupported platform. Expected either ios or android.`,
          });
        }

        // 必须是与客户端兼容的运行时版本。运行时版本规定了客户端正在运行的本地代码配置。它应该在构建客户端时设置。例如，在iOS客户端中，该值可能设置在plist文件中。
        // 默认 app
        const runtimeVersion = (request.headers["expo-runtime-version"] ??
          (request.query as any)["runtime-version"]) as string;
        if (!runtimeVersion || typeof runtimeVersion !== "string") {
          return reply.code(400).send({ error: `No runtimeVersion provided.` });
        }

        try {
          // 最新最新更新包路径（按文件夹名称倒叙）
          const updateBundlePath =
            await getLatestUpdateBundlePathForRuntimeVersionAsync(
              runtimeVersion
            );
          // 获取更新类型（更新/回滚）
          const updateType = await getTypeOfUpdateAsync(updateBundlePath); 

          if (updateType === UpdateType.NORMAL_UPDATE) {
            // 正常更新
            await putUpdateInResponseAsync(
              request,
              reply,
              updateBundlePath,
              runtimeVersion,
              platform,
              protocolVersion
            );
          } else {
            // 回滚
            await putRollBackInResponseAsync(
              request,
              reply,
              updateBundlePath,
              protocolVersion
            );
          }
        } catch (maybeNoUpdateAvailableError) {
          if (maybeNoUpdateAvailableError instanceof NoUpdateAvailableError) {
            // 无更新可用
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
  // 文件名中是否有 rollback
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
  // 获取 metadata 数据
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

  // 获取 更新包 expoConfig.json 数据
  const expoConfig = await getExpoConfigAsync({
    updateBundlePath,
    runtimeVersion,
  });
  // 特定平台元数据
  const platformSpecificMetadata = metadataJson.fileMetadata[platform];
  const manifest = {
    id: convertSHA256HashToUUID(id),
    createdAt,
    runtimeVersion,
    // 资产元数据
    // 应用运行所需的其他资源，比如图片、字体等。
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
    // 应用启动时必须加载的 JS bundle
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

  // 密钥校验
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

  // 服务器在生成更新清单（manifest）时，可以附带一个名为 `assetRequestHeaders` 的扩展字段。
  // 这个字段告诉客户端：“当你接下来要下载清单里列出的这些资源文件时，必须在你发出的每一个下载请求中，都加上我指定的这些 HTTP 请求头。”
  // 在这段示例代码中，它遍历了所有资源文件，并为每一个文件都指定了一个名为 `test-header`、值为 `test-header-value` 的请求头。
  // 这里的 `test-header` 本身没有特殊功能**。由于 `custom-expo-updates-server` 是一个用于演示和学习目的的示例项目，这里的 `test-header` 主要起**示例作用**。它向开发者展示了如何使用 `assetRequestHeaders` 机制。
  // 在真实的生产环境中，这个功能非常有用。你可以用它来实现一些高级功能，例如：
  // *   **访问控制/鉴权**：可以为每个资源的下载链接动态生成有时效性的授权 Token，并放在请求头中。这样，只有通过你的更新服务器获取清单的合法客户端，才能凭有效的 Token 下载资源，防止资源被盗链。
  //   *   例如，你可以将 `"test-header": "test-header-value"` 替换为 `"Authorization": "Bearer your-generated-token"`。
  // *   **缓存控制**：为不同类型的资源指定不同的缓存策略，通过 `Cache-Control` 等请求头来优化 CDN 或客户端的缓存行为。
  // *   **数据分析**：在请求头中加入一些追踪信息，用于统计分析资源的下载情况。
  const assetRequestHeaders: { [key: string]: object } = {};
  [...manifest.assets, manifest.launchAsset].forEach((asset) => {
    assetRequestHeaders[asset.key] = {
      "assets-request": "assets-request-value",
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
  // 将一个构建好的表单数据（FormData 对象）转换成一个底层 HTTP 请求所需的原始二进制 Buffer
  reply.send(form.getBuffer());
}

// 将回滚作为异步响应
async function putRollBackInResponseAsync(
  request: FastifyRequest, 
  reply: FastifyReply,
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

// 无更新可用
async function putNoUpdateAvailableInResponseAsync(
  request: FastifyRequest, 
  reply: FastifyReply, 
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
