import express from 'express';
import { upload, handleUpload } from '../services/attachmentVault.js';

const router = express.Router();

router.post('/:uiId', upload.array('files'), handleUpload);

export default router;
