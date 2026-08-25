import { AppController } from './app.controller';

describe('AppController', () => {
  it('reports ok on health', () => {
    expect(new AppController().health()).toEqual({ status: 'ok' });
  });
});
