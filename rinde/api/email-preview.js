// GET /api/email-preview?type=daily|weekly — vista previa de los emails con la cuenta DEMO (datos ficticios).
import { handler, html, query, appUrl } from './_lib/http.js';
import { getDemoData } from '../shared/demo-data.js';
import { buildModel, buildRuleSummary } from '../shared/model.js';
import { dailyAlertEmail, weeklyEmail } from './_lib/email.js';

export default handler(async (req, res) => {
  const { type } = query(req);
  const d = getDemoData();
  const model = buildModel(d);
  const base = appUrl(req);
  const mail = type === 'weekly'
    ? weeklyEmail({ nickname: d.seller.nickname, model, summary: buildRuleSummary(model), appUrl: base })
    : dailyAlertEmail({ nickname: d.seller.nickname, alerts: model.alerts.slice(0, 6), appUrl: base });
  html(res, 200, mail.html);
});
