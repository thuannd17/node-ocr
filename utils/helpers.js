import fs from 'node:fs';

const listFilesInFolder = (folderPath, amount = 0) => {
	// 1. Get all items in the directory
	const allItems = fs.readdirSync(folderPath, { recursive: false, withFileTypes: true });

	// 2. Filter out subdirectories to keep only files
	const files = allItems.filter(item => item.isFile());

	// 3. Take the first some files
	return amount > 0 ? files.slice(0, amount) : files;
}

const writeFile = (buffer, filePath = 'output.txt') => {
	fs.writeFileSync(filePath, buffer, 'utf8');
}

export {
	listFilesInFolder,
	writeFile
};
