import { INestApplication, ValidationPipe } from '@nestjs/common';

// Shared with the e2e suites so a request is validated in a test exactly as in production.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
