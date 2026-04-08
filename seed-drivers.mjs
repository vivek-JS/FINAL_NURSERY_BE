import mongoose from '/var/www/FINAL_NURSERY_BE/node_modules/mongoose/index.js';

const MONGO_URL = 'mongodb+srv://vivek_new:hrfzj0MMQacvBQqo@ram.tddrg8s.mongodb.net/nursery?retryWrites=true&w=majority';

const employeeSchema = new mongoose.Schema({
  employee_id: { type: String, unique: true, sparse: true },
  name:        { type: String },
  email:       { type: String, unique: true },
  phoneNumber: { type: Number, unique: true, sparse: true },
  mobile:      { type: String },
  department:  { type: String },
  jobTitle:    { type: String },
}, { strict: false });

const Employee = mongoose.models.Employee || mongoose.model('Employee', employeeSchema, 'employees');

const drivers = [
  { name: 'Vinod Nehate',       phoneNumber: 7020147651 },
  { name: 'Mohit Dhake',        phoneNumber: 9021242795 },
  { name: 'Talele Sagar',       phoneNumber: 7220946237 },
  { name: 'Sagar Palve',        phoneNumber: 8229811013 },
  { name: 'Akash Tayde',        phoneNumber: 9834597121 },
  { name: 'Amol Patil',         phoneNumber: 7507692423 },
  { name: 'Vilas Kumbhar',      phoneNumber: 8000139376 },
  { name: 'Bhura Bhilala',      phoneNumber: 8412040549 },
  { name: 'Karan Tanwar',       phoneNumber: 8329798570 },
  { name: 'Vikas Sonawane',     phoneNumber: 9665074268 },
  { name: 'Dinesh Suryawanshi', phoneNumber: 8999778787 },
  { name: 'Ananda Rathod',      phoneNumber: 8080504160 },
  { name: 'Nilesh Patil',       phoneNumber: 9766635322 },
  { name: 'Rajendra Dhayde',    phoneNumber: 9860966365 },
  { name: 'Savle Kiran',        phoneNumber: 8806776669 },
  { name: 'Vasudev Marathe',    phoneNumber: 9730813989 },
  { name: 'Ravindra Koli',      phoneNumber: 8010849343 },
  { name: 'Shubham Salve',      phoneNumber: 8369421044 },
  { name: 'Pradip Sonawane',    phoneNumber: 9284024016 },
  { name: 'Kiran Barela',       phoneNumber: 7558391080 },
  { name: 'Krishna Transport',  phoneNumber: 9011108582 },
];

await mongoose.connect(MONGO_URL);
console.log('Connected');

let inserted = 0, skipped = 0;
for (const d of drivers) {
  const slug = d.name.toLowerCase().replace(/\s+/g, '.') + '.' + d.phoneNumber;
  const doc = {
    name:        d.name,
    email:       `${slug}@rambiotech.driver`,
    phoneNumber: d.phoneNumber,
    mobile:      String(d.phoneNumber),
    jobTitle:    'Driver',
    department:  'Transport',
  };
  try {
    await Employee.findOneAndUpdate(
      { phoneNumber: d.phoneNumber },
      { $setOnInsert: doc },
      { upsert: true, new: true }
    );
    console.log(`✓ ${d.name} — ${d.phoneNumber}`);
    inserted++;
  } catch (e) {
    if (e.code === 11000) {
      console.log(`⚠ SKIP (exists): ${d.name}`);
      skipped++;
    } else {
      console.log(`✗ FAIL: ${d.name} — ${e.message}`);
    }
  }
}

console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
await mongoose.disconnect();
