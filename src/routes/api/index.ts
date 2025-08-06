import { FastifyPluginAsync } from 'fastify'

const api: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get('/', async function (request, reply) {
    return 'this is api'
  })
}

export default api
