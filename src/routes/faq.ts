import { Router } from 'express';
import path from 'path';

export const faqRouter = Router();

const faqPath = path.join(process.cwd(), 'public', 'faq.html');

faqRouter.get('/faq', (_req, res) => {
  res.sendFile(faqPath, (err) => {
    if (err) {
      res.status(404).send('FAQ page not found');
    }
  });
});
