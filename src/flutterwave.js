import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import config from "./config.js";

const flw = axios.create({
  baseURL: config.flwBaseUrl,
  headers: {
    Authorization: `Bearer ${config.flwSecretKey}`,
    "Content-Type": "application/json",
  },
});

const RETRY_STATUSES = new Set([502, 504]);
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates a dynamic (temporary) virtual account for a specific transaction.
 * Uses Flutterwave v3 API.
 *
 * @param {string} phone     - User's phone number
 * @param {number} amount    - Exact plan price
 * @param {string} planName  - Plan name for narration
 * @returns {Promise<{ txRef: string, accountNumber: string, bankName: string, accountName: string }>}
 */
export async function createDynamicVirtualAccount(phone, amount, planName) {
  const ispPhone = (config.adminPhones[0] || "07068380792").replace(/^234/, "0");
  const narration = `${config.ispName} ${planName}`;

  const reqBody = {
    email: process.env.FLW_EMAIL || "billing@choxa.net",
    is_permanent: false,
    amount,
    currency: "NGN",
    narration,
    phonenumber: ispPhone,
    firstname: config.ispName.split(" ")[0] || "CHOXA",
    lastname: config.ispName.split(" ")[1] || "INTERNET",
    frequency: 1,
  };

  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const txRef = uuidv4();

    try {
      const response = await flw.post("/virtual-account-numbers", {
        ...reqBody,
        tx_ref: txRef,
      });

      const data = response.data.data;
      return {
        txRef,
        accountNumber: data.account_number,
        accountName: data.account_name || `${config.ispName} ${planName}`,
        bankName: data.bank_name,
      };
    } catch (error) {
      const status = error.response?.status;
      lastError = error;

      if (RETRY_STATUSES.has(status) && attempt < RETRY_ATTEMPTS) {
        console.warn(
          `Flutterwave ${status} on attempt ${attempt}/${RETRY_ATTEMPTS} — retrying in ${
            RETRY_DELAY_MS / 1000
          }s...`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      console.error(
        "Flutterwave Virtual Account Error:",
        error.response?.data || error.message,
      );
      break;
    }
  }
  throw lastError;
}

/**
 * Verifies whether a Flutterwave virtual account transaction was paid.
 *
 * @param {string} txRef   - The tx_ref UUID
 * @param {number} amount  - Expected amount in NGN
 * @returns {Promise<{ paid: boolean, amountPaid: number, flwRef?: string }>}
 */
export async function verifyVirtualAccountPayment(txRef, amount) {
  try {
    const response = await flw.get(
      `/transactions/verify-by-reference?tx_ref=${txRef}`,
    );
    const data = response.data.data;

    if (
      data &&
      data.status === "successful" &&
      data.currency === "NGN" &&
      data.amount >= amount
    ) {
      return { paid: true, amountPaid: data.amount, flwRef: data.flw_ref };
    }

    return { paid: false, amountPaid: 0 };
  } catch (error) {
    if (error.response?.status === 404) {
      return { paid: false, amountPaid: 0 };
    }
    console.error("Flutterwave verification error:", error.response?.data || error.message);
    throw error;
  }
}
