import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const spec = new DocumentBuilder()
    .setTitle('Cocos trading API')
    .setDescription('Portfolio, instrument search and order placement.')
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, spec));

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
