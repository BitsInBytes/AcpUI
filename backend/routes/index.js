import express from 'express';
import uploadRoutes from './upload.js';
import staticRoutes from './static.js';

const router = express.Router();

router.use('/upload', uploadRoutes);
router.use('/', staticRoutes);

export default router;
