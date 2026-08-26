import { INestApplication, ValidationPipe } from '@nestjs/common';

// Shared with the e2e suites, so a request is validated in a test exactly as it is in
// production instead of against a pipe each suite declares for itself.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
