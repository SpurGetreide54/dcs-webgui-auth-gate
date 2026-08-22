// Seeds/updates the `servers` table with the three real DCS instances.
// Edit the upstream_url values below to the physical host's real internal
// IP and each server's control-port webgui port before running this against
// a real deployment.
//
// Usage: npm run seed-servers

const db = require("../src/db");

const SERVERS = [
  {
    slug: "training",
    name: "DCS Deutschland - Training",
    upstream_url: "http://10.0.1.10:8088",
    mission_folder_key: "training",
  },
  {
    slug: "community1",
    name: "DCS Deutschland - Community 1",
    upstream_url: "http://10.0.1.10:8089",
    mission_folder_key: "community1",
  },
  {
    slug: "community2",
    name: "DCS Deutschland - Community 2",
    upstream_url: "http://10.0.1.10:8090",
    mission_folder_key: "community2",
  },
];

const upsert = db.prepare(`
  INSERT INTO servers (slug, name, upstream_url, mission_folder_key)
  VALUES (@slug, @name, @upstream_url, @mission_folder_key)
  ON CONFLICT (slug) DO UPDATE SET
    name = excluded.name,
    upstream_url = excluded.upstream_url,
    mission_folder_key = excluded.mission_folder_key
`);

const insertMany = db.transaction((servers) => {
  for (const server of servers) upsert.run(server);
});

insertMany(SERVERS);

console.log(`Seeded ${SERVERS.length} servers:`);
for (const s of db.prepare("SELECT slug, name, upstream_url FROM servers ORDER BY id").all()) {
  console.log(`  ${s.slug} — ${s.name} — ${s.upstream_url}`);
}
