import { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { logger } from './logger';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'GoogleShift Backend API',
      version: '1.0.0',
      description: 'API documentation for GoogleShift Google Drive Migration Platform'
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development Server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'connect.sid'
        }
      }
    }
  },
  apis: ['./src/routes/*.ts', './src/auth/*.ts']
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Express): void {
  if (process.env.NODE_ENV === 'production') {
    logger.info('[Swagger] Disabled in production environment.');
    return;
  }

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  logger.info('✓ [Swagger] API Documentation mounted at http://localhost:' + (process.env.PORT || 3000) + '/docs');
}
