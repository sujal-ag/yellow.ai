import { Router } from 'express';
import * as controller from '../controllers/campaign.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.post('/', asyncHandler(controller.create));
router.get('/:id', asyncHandler(controller.getById));
// POST /:id/cancel - deferred (see README "Not yet covered")

export default router;
