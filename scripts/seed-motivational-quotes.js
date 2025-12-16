import mongoose from "mongoose";
import dotenv from "dotenv";
import MotivationalQuote from "../models/motivationalQuote.model.js";

// Load environment variables - try multiple paths and variable names
dotenv.config({ path: "./.env" });
if (!process.env.MONGO_URI && !process.env.DATABASE_URL && !process.env.MONGODB_URI) {
  dotenv.config({ path: "../.env" });
}
if (!process.env.MONGO_URI && !process.env.DATABASE_URL && !process.env.MONGODB_URI) {
  dotenv.config({ path: ".env.local" });
}

const quotes = [
  { id: 1, line1: "काम स्वतः बोलतं.", line2: "शब्द मागे पडतात." },
  { id: 2, line1: "गुणवत्ता सांगावी लागत नाही.", line2: "ती कामातून दिसते." },
  { id: 3, line1: "सातत्य जिथे आहे.", line2: "प्रगती तिथे थांबत नाही." },
  { id: 4, line1: "काम रोजचंच असतं.", line2: "पण परिणाम वाढत जातो." },
  { id: 5, line1: "शिस्त नसली.", line2: "तर कौशल्य निष्फळ ठरतं." },
  { id: 6, line1: "पद्धत मजबूत असेल.", line2: "तर चूक टिकत नाही." },
  { id: 7, line1: "जबाबदारी घेतली.", line2: "तर कारणं संपतात." },
  { id: 8, line1: "मेहनत दिसत नाही.", line2: "पण भविष्य ठरवते." },
  { id: 9, line1: "काम नीट केलं.", line2: "तर दुरुस्ती लागत नाही." },
  { id: 10, line1: "वेग महत्त्वाचा नाही.", line2: "दिशा महत्त्वाची आहे." },
  { id: 11, line1: "गुणवत्तेची तडजोड झाली.", line2: "तर विश्वास तुटतो." },
  { id: 12, line1: "रोजचं काम लहान वाटेल.", line2: "पण त्यातूनच मोठं घडतं." },
  { id: 13, line1: "व्यवस्था माणसांवर चालते.", line2: "माणसं बांधिलकीमुळे टिकतात." },
  { id: 14, line1: "पद्धत पाळली.", line2: "तर गोंधळ राहत नाही." },
  { id: 15, line1: "कामावर नियंत्रण असेल.", line2: "तर निकाल निश्चित असतो." },
  { id: 16, line1: "शिस्त म्हणजेच ताकद.", line2: "बाकी सगळं आवाज आहे." },
  { id: 17, line1: "मेहनत एकदाच नाही.", line2: "ती रोज द्यावी लागते." },
  { id: 18, line1: "रोप हळूहळू वाढतं.", line2: "कारण मुळं मजबूत असतात." },
  { id: 19, line1: "काम वेळेत झालं.", line2: "तर अडचण जन्म घेत नाही." },
  { id: 20, line1: "गुणवत्ता ही सवय आहे.", line2: "अपघात नाही." },
  { id: 21, line1: "जबाबदारीची संस्कृती तयार झाली.", line2: "तर व्यवस्था चालते." },
  { id: 22, line1: "लक्ष जिथे आहे.", line2: "प्रगती तिथेच दिसते." },
  { id: 23, line1: "सातत्य दुर्मिळ आहे.", line2: "म्हणूनच ते जिंकतं." },
  { id: 24, line1: "कामात गांभीर्य नसेल.", line2: "तर भविष्य अस्थिर राहतं." },
  { id: 25, line1: "मेहनत गुंतवली.", line2: "तर परतावा वाढतो." },
  { id: 26, line1: "पद्धत स्पष्ट असेल.", line2: "तर अंमलबजावणी सोपी होते." },
  { id: 27, line1: "रोज सुधारणा केली.", line2: "तर मोठी चूक टळते." },
  { id: 28, line1: "कामावर हक्क घेतला.", line2: "तर निकाल स्वतःचा होतो." },
  { id: 29, line1: "मेहनत शांत असते.", line2: "परिणाम मोठा असतो." },
  { id: 30, line1: "आज नीट केलं.", line2: "तर उद्या सोपं होतं." },
];

const seedQuotes = async () => {
  try {
    // Connect to MongoDB - try multiple possible env variable names
    const mongoUri = process.env.MONGODB_URI 
      || process.env.MONGO_URI 
      || process.env.DATABASE_URL 
      || process.env.DB_URI
      || process.env.DB_URL
      || process.env.MONGO_URL;
    
    if (!mongoUri) {
      console.error("❌ Database connection string not found in environment variables");
      console.error("   Please set one of: MONGODB_URI, MONGO_URI, DATABASE_URL, DB_URI, DB_URL, or MONGO_URL");
      console.error("   Current .env file location:", process.cwd() + "/.env");
      console.error("   Available env vars:", Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DATABASE') || k.includes('DB')).join(', ') || 'none');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    let inserted = 0;
    let updated = 0;

    for (const quote of quotes) {
      const existingQuote = await MotivationalQuote.findOne({ id: quote.id });

      if (existingQuote) {
        existingQuote.line1 = quote.line1;
        existingQuote.line2 = quote.line2;
        existingQuote.isActive = true;
        await existingQuote.save();
        updated++;
        console.log(`✅ Updated quote ${quote.id}`);
      } else {
        await MotivationalQuote.create(quote);
        inserted++;
        console.log(`✅ Inserted quote ${quote.id}`);
      }
    }

    console.log("\n📊 Summary:");
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Total: ${quotes.length}`);

    await mongoose.connection.close();
    console.log("\n✅ Database connection closed");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding quotes:", error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the seed function
seedQuotes();

