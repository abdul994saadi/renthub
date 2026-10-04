// Adds demo shops and cars so the site has something to show.
// Every demo shop logs in with password "demo1234".
const { db } = require('../src/db');
const { hashPassword } = require('../src/auth');

if (db.prepare('SELECT COUNT(*) AS n FROM shops').get().n > 0) {
  console.log('Database already has shops; skipping seed.');
  process.exit(0);
}

const shops = [
  {
    name: 'City Drive Rentals', email: 'citydrive@example.com', phone: '+961 1 555 101', city: 'Beirut',
    address: '12 Hamra Street', opening_hours: 'Daily 8:00–22:00',
    description: 'Family-run rental shop with new, well-kept cars and free delivery within the city.',
    cars: [
      ['Toyota', 'Corolla', 2024, 'Sedan', 'Automatic', 'Petrol', 5, 4, 45, 200, 'Air conditioning, Bluetooth, Apple CarPlay, Reversing camera'],
      ['Nissan', 'Patrol', 2023, 'SUV', 'Automatic', 'Petrol', 7, 4, 140, 1000, 'Air conditioning, GPS, 4x4, Leather seats, Cruise control'],
      ['Kia', 'Picanto', 2024, 'Economy', 'Automatic', 'Petrol', 4, 4, 28, 100, 'Air conditioning, Bluetooth'],
      ['Tesla', 'Model 3', 2024, 'Electric', 'Automatic', 'Electric', 5, 4, 110, 800, 'Air conditioning, GPS, Bluetooth, Reversing camera, Cruise control'],
    ],
  },
  {
    name: 'Desert Wheels', email: 'desertwheels@example.com', phone: '+961 9 555 202', city: 'Jounieh',
    address: '45 Fouad Chehab Road', opening_hours: 'Mon–Sat 9:00–21:00',
    description: '4x4 and SUV specialists. Ask us about mountain-ready 4x4s.',
    cars: [
      ['Toyota', 'Land Cruiser', 2023, 'SUV', 'Automatic', 'Petrol', 7, 4, 180, 1500, 'Air conditioning, GPS, 4x4, Leather seats, Sunroof'],
      ['Mitsubishi', 'Pajero', 2022, 'SUV', 'Automatic', 'Petrol', 7, 4, 85, 500, 'Air conditioning, 4x4, Bluetooth'],
      ['Toyota', 'Hilux', 2023, 'Pickup', 'Manual', 'Diesel', 5, 4, 75, 500, '4x4, Air conditioning, Bluetooth'],
    ],
  },
  {
    name: 'Prestige Motors', email: 'prestige@example.com', phone: '+961 9 555 303', city: 'Byblos',
    address: '8 Old Souk Road', opening_hours: 'Daily 10:00–20:00',
    description: 'Luxury and sports cars for special occasions.',
    cars: [
      ['Mercedes-Benz', 'E-Class', 2024, 'Luxury', 'Automatic', 'Petrol', 5, 4, 220, 2000, 'Leather seats, GPS, Apple CarPlay, Sunroof, Cruise control'],
      ['Ford', 'Mustang', 2023, 'Sports', 'Automatic', 'Petrol', 4, 2, 190, 2000, 'Leather seats, Bluetooth, Reversing camera'],
      ['Hyundai', 'H-1', 2022, 'Van', 'Automatic', 'Diesel', 9, 4, 95, 500, 'Air conditioning, Bluetooth, Child seat available'],
    ],
  },
];

const password = hashPassword('demo1234');
const insertShop = db.prepare(
  'INSERT INTO shops (name, email, password_hash, phone, city, address, opening_hours, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const insertCar = db.prepare(
  `INSERT INTO cars (shop_id, make, model, year, category, transmission, fuel, seats, doors, daily_price, deposit, features, description)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

for (const s of shops) {
  const { lastInsertRowid: shopId } = insertShop.run(s.name, s.email, password, s.phone, s.city, s.address, s.opening_hours, s.description);
  for (const c of s.cars) {
    insertCar.run(shopId, ...c, `Clean, non-smoking ${c[0]} ${c[1]}. Full tank on pick-up; please return it full.`);
  }
}
console.log(`Seeded ${shops.length} shops. Log in as e.g. citydrive@example.com / demo1234`);
