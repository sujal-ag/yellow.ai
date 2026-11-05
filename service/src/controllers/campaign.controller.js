// HTTP in/out for campaigns: parse + validate, call the service, pick status codes.

import * as campaignService from '../services/campaign.service.js';
import { parseCreateCampaign, parseCampaignId } from '../validators/campaign.validator.js';

export async function create(req, res) {
  const input = parseCreateCampaign(req.body);
  const campaign = await campaignService.createCampaign(input);
  res.status(201).json(campaign);
}

export async function getById(req, res) {
  const id = parseCampaignId(req.params.id);
  res.json(await campaignService.getCampaign(id));
}
