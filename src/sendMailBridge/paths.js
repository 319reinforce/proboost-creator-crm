const path = require('path');

const SEND_MAIL_ROOT = process.env.SEND_MAIL_ROOT || '/Users/depp/send-mail';

module.exports = {
  SEND_MAIL_ROOT,
  splitScript: path.join(SEND_MAIL_ROOT, 'split-creators.js'),
  autoScript: path.join(SEND_MAIL_ROOT, 'proboost-auto.js'),
};
