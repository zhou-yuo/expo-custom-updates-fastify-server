import { join } from 'node:path'
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload'
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import fastifyStatic from '@fastify/static';

export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {

}
// Pass --options via CLI arguments in command to enable these options.
const options: AppOptions = {
}

const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts
): Promise<void> => {
  // Place here your custom code!

  // 注册 @fastify/static 插件来处理所有静态资源
  // 这将有效地处理所有对 assets 的请求
  fastify.register(fastifyStatic, {
    // 静态文件的根目录，我们假设它在项目根目录下的 'updates' 文件夹中
    root: join(__dirname, '..', 'updates'),
    // 可选：如果你的 manifest.json 中的资产 URL 有特定的前缀，可以在这里设置
    // 例如，如果 URL 是 /assets/bundle.js，则设置 prefix 为 /assets/
    // 为了与之前的示例保持一致，我们假设 manifest 中的 URL 直接指向文件路径
    // 例如 /1.0.0/android/bundle.js，所以这里不需要 prefix
  });

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  // eslint-disable-next-line no-void
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: opts
  })

  // This loads all plugins defined in routes
  // define your routes in one of these
  // eslint-disable-next-line no-void
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'routes'),
    options: opts
  })
}

export default app
export { app, options }
