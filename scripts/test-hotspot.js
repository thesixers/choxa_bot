import {
    provisionHotspotUser,
    getHotspotUser,
    updateHotspotUser,
    removeHotspotUser,
    getMikrotikClient
} from '../src/mikrotik.js';

const TEST_PIN     = '889900';
const TEST_PROFILE = 'Hour'; // Match router profile (e.g. Hour, DAY, Week)

async function step1_createUser() {
    console.log(`\n1️⃣  Creating hotspot ticket user via PUT: ${TEST_PIN}`);
    await provisionHotspotUser(TEST_PIN, TEST_PROFILE, 'Automated Test Ticket', '0d 01:00:00');
    console.log(`✅ User created / provisioned — PIN: ${TEST_PIN}, profile: ${TEST_PROFILE}`);
}

async function step2_verifyUser() {
    console.log(`\n2️⃣  Verifying user exists on router via GET ?name=${TEST_PIN}...`);
    const user = await getHotspotUser(TEST_PIN);
    if (!user) throw new Error(`User ${TEST_PIN} not found on router!`);

    console.log(`✅ Confirmed on router:`);
    console.log(`   ID:       ${user['.id']}`);
    console.log(`   Name:     ${user.name}`);
    console.log(`   Profile:  ${user.profile}`);
    console.log(`   Password: ${user.password}`);
    return user;
}

async function step3_updateUser(user) {
    const newProfile = 'DAY';
    console.log(`\n3️⃣  Updating user profile to ${newProfile} via PATCH...`);
    await updateHotspotUser(user['.id'], { profile: newProfile });
    const updated = await getHotspotUser(TEST_PIN);
    console.log(`✅ Profile updated to: ${updated?.profile}`);
}

async function step4_cleanup() {
    console.log(`\n4️⃣  Cleanup — removing test user via DELETE...`);
    await removeHotspotUser(TEST_PIN);
    console.log(`✅ Test user removed`);
}

async function run() {
    const client = getMikrotikClient();
    console.log('🧪 Hotspot User HTTP Provisioning Test');
    console.log(`   Router Base URL: ${client.defaults.baseURL}`);
    console.log(`   Initial Profile: ${TEST_PROFILE}`);

    await step1_createUser();
    const user = await step2_verifyUser();
    await step3_updateUser(user);
    await step4_cleanup();

    console.log('\n🎉 All steps passed — hotspot HTTP provisioning is fully working!');
}

run().catch((err) => {
    console.error(`\n❌ Test failed:`, err.response?.data || err.message);
    process.exit(1);
});
