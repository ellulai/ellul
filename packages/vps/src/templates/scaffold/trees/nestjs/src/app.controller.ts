import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello() {
    return { message: 'Your app is ready.', powered: 'ellul' };
  }

  @Get('/api/health')
  health() {
    return { ok: true };
  }
}
