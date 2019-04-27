import * as vscode from 'vscode';
import { TestSuiteInfo, TestInfo, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent } from 'vscode-test-adapter-api';
import * as childProcess from 'child_process';

/**
 * Representation of the Rspec test suite as a TestSuiteInfo object.
 * 
 * @return The Rspec test suite as a TestSuiteInfo object.
 */
const rspecTests = async () => new Promise<TestSuiteInfo>((resolve, reject) => {
  try {
    let rspecTests = loadRspecTests();
    return resolve(rspecTests);
  } catch(err) {
    return reject(err);
  }
});

/**
 * Perform a dry-run of the test suite to get information about every test.
 * 
 * @return The raw output from the Rspec JSON formatter.
 */
const initRspecTests = async () => new Promise<string>((resolve, reject) => {
  let cmd = `${getRspecCommand()} --format json --dry-run`;

  const execArgs: childProcess.ExecOptions = {
    cwd: vscode.workspace.rootPath,
    maxBuffer: 400 * 1024
  };

  childProcess.exec(cmd, execArgs, (err, stdout) => {
    if (err) {
      return reject(err);
    }
    resolve(stdout);
  });
});

/**
 * Takes the output from initRspecTests() and parses the resulting
 * JSON into a TestSuiteInfo object.
 * 
 * @return The full Rspec test suite.
 */
export async function loadRspecTests(): Promise<TestSuiteInfo> {
  let output = await initRspecTests();
  output = getJsonFromRspecOutput(output);
  let rspecMetadata = JSON.parse(output);
  
  let tests: Array<{ id: string; full_description: string; description: string; file_path: string; line_number: number; location: number; }> = [];

  rspecMetadata.examples.forEach((test: { id: string; full_description: string; description: string; file_path: string; line_number: number; location: number; }) => {
    let test_location_array: Array<string> = test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':');
    let test_location_string: string = test_location_array.join('');
    test.location = parseInt(test_location_string);

    tests.push(test);
  });

  let testSuite: TestSuiteInfo = await getBaseTestSuite(tests);
  
  // Sort the children of each test suite based on their location in the test tree.
  (testSuite.children as Array<TestSuiteInfo>).forEach((suite: TestSuiteInfo) => {
    // NOTE: This will only sort correctly if everything is nested at the same
    // level, e.g. 111, 112, 121, etc. Once a fourth level of indentation is
    // introduced, the location is generated as e.g. 1231, which won't
    // sort properly relative to everything else.
    (suite.children as Array<TestInfo>).sort((a: TestInfo, b: TestInfo) => {
      if ((a as TestInfo).type === "test" && (b as TestInfo).type === "test") {
        let aLocation: number = getTestLocation(a as TestInfo);
        let bLocation: number = getTestLocation(b as TestInfo);
        return aLocation - bLocation;
      } else {
        return 0;
      }
    })
  });

  return Promise.resolve<TestSuiteInfo>(testSuite);
}

/**
 * Pull JSON out of the Rspec output.
 * 
 * Rspec frequently returns bad data even when it's told to format the output
 * as JSON, e.g. due to code coverage messages and other injections from gems.
 * This tries to get the JSON by stripping everything before the first opening
 * brace and after the last closing brace. It's probably not perfect, but it's
 * worked for everything I've tried so far.
 * 
 * @param output The output returned by running an Rspec command
 * @return A string representation of the JSON found in the Rspec output.
 */
function getJsonFromRspecOutput(output: string): string {
  return output.substring(output.indexOf("{"), output.lastIndexOf("}") + 1);
}

/**
 * Get the location of the test in the testing tree.
 * 
 * Test ids are in the form of `/spec/model/game_spec.rb[1:1:1]`, and this
 * function turns that into `111`. The number is used to order the tests
 * in the explorer.
 * 
 * @param test The test we want to get the location of.
 * @return A number representing the location of the test in the test tree.
 */
function getTestLocation(test: TestInfo): number {
  return parseInt(test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':').join(''));
}

/**
 * Get the user-configured Rspec command, if there is one.
 *
 * @return The Rspec command
 */
function getRspecCommand(): string {
  let command: string = (vscode.workspace.getConfiguration('rubyTestExplorer', null).get('rspecCommand') as string);
  return command || 'bundle exec rspec';
}

/**
 * Create the base test suite with a root node and child nodes representing each
 * test file discovered by Rspec.
 * 
 * @param tests Test objects returned by Rspec's JSON formatter.
 * @return The test suite root with its direct children.
 */
export async function getBaseTestSuite(
  tests: any[]
): Promise<TestSuiteInfo> {
  let testSuite: TestSuiteInfo = {
    type: 'suite',
    id: 'root',
    label: 'Rspec',
    children: []
  };

  let uniqueFiles = [...new Set(tests.map((test: { file_path: string; }) => test.file_path))];

  uniqueFiles.forEach((current_file: string) => {
    let current_file_tests = tests.filter(test => {
      return test.file_path === current_file
    });

    let current_file_tests_info = current_file_tests as unknown as Array<TestInfo>;
    current_file_tests_info.forEach((test: TestInfo) => {
      test.type = 'test';
      test.label = '';
    });

    let current_file_test_info_array: Array<TestInfo> = current_file_tests_info.map((test: any) => {
      // Concatenation of "/Users/username/whatever/project_dir" and "./spec/path/here.rb", but with the latter's first character stripped.
      let file_path: string = `${vscode.workspace.rootPath}${test.file_path.substr(1)}`;

      let temp_test_location_array: Array<string> = test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':');
      let test_location_array: Array<number> = temp_test_location_array.map((x: string) => {
        return parseInt(x);
      });

      // Get the last element in the location array.
      let test_number: number = test_location_array[test_location_array.length - 1];
      let description: string = test.description.startsWith('example at ') ? `${test.full_description}test #${test_number}` : test.full_description;

      let testInfo: TestInfo = {
        type: 'test',
        id: test.id,
        label: description,
        file: file_path,
        // Line numbers are 0-indexed... for some reason.
        line: test.line_number - 1
      }

      return testInfo;
    });

    let currentFileTestSuite: TestSuiteInfo = {
      type: 'suite',
      id: current_file,
      label: current_file,
      children: current_file_test_info_array
    }

    testSuite.children.push(currentFileTestSuite);
  });

  return testSuite;
}

/**
 * Runs a single test.
 * 
 * @param testLocation A file path with a line number, e.g. `/path/to/spec.rb:12`.
 * @return The raw output from running the test.
 */
let runSingleTest = async (testLocation: string | undefined) => new Promise<string>((resolve, reject) => {
  let cmd = `${getRspecCommand()} --format json ${testLocation !== undefined ? testLocation : ''}`;

  const execArgs: childProcess.ExecOptions = {
    cwd: vscode.workspace.rootPath,
    maxBuffer: 400 * 1024
  };

  childProcess.exec(cmd, execArgs, (err, stdout) => {
    resolve(stdout);
  });
});

/**
 * Runs the full test suite for the current workspace.
 * 
 * @return The raw output from running the test suite.
 */
let runFullTestSuite = async () => new Promise<string>((resolve, reject) => {
  let cmd = `${getRspecCommand()} --format json`;

  const execArgs: childProcess.ExecOptions = {
    cwd: vscode.workspace.rootPath,
    maxBuffer: 400 * 1024
  };

  childProcess.exec(cmd, execArgs, (err, stdout) => {
    resolve(stdout);
  });
});

/**
 * Runs the test suite by iterating through each test and running it.
 * 
 * @param tests 
 * @param testStatesEmitter 
 */
export async function runRspecTests(
  tests: string[],
  testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>
): Promise<void> {
  let testSuite: TestSuiteInfo = await rspecTests();

  for (const suiteOrTestId of tests) {
    const node = findNode(testSuite, suiteOrTestId);
    if (node) {
      await runNode(node, testStatesEmitter);
    }
  }
}

/**
 * 
 * @param searchNode The test or test suite to search in.
 * @param id The id of the test or test suite.
 */
function findNode(searchNode: TestSuiteInfo | TestInfo, id: string): TestSuiteInfo | TestInfo | undefined {
  if (searchNode.id === id) {
    return searchNode;
  } else if (searchNode.type === 'suite') {
    for (const child of searchNode.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 
 * @param node A test or test suite.
 * @param testStatesEmitter An emitter for the test suite's state.
 */
async function runNode(
  node: TestSuiteInfo | TestInfo,
  testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>
): Promise<void> {

  // Special case handling for the root suite, since it can be run
  // with runFullTestSuite()
  if (node.type === 'suite' && node.id === 'root') {
    testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'running' });
    
    let testOutput = await runFullTestSuite();
    testOutput = getJsonFromRspecOutput(testOutput);
    let testMetadata = JSON.parse(testOutput);
    let tests = testMetadata.examples;

    tests.forEach((test: { id: string | TestInfo; }) => {
      handleStatus(test, testStatesEmitter);
    });

    testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });
  } else if (node.type === 'suite') {

    testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'running' });

    for (const child of node.children) {
      await runNode(child, testStatesEmitter);
    }

    testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });

  } else if (node.type === 'test') {
    if (node.file !== undefined && node.line !== undefined) {
      testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'running' });
      
      // Run the test at the given line, add one since the line is 0-indexed in
      // VS Code and 1-indexed for Rspec.
      let testOutput = await runSingleTest(`${node.file}:${node.line + 1}`);

      testOutput = getJsonFromRspecOutput(testOutput);
      let testMetadata = JSON.parse(testOutput);
      let currentTest = testMetadata.examples[0];

      handleStatus(currentTest, testStatesEmitter);
    }
  }
}

/**
 * Handles test state based on the output returned by Rspec's JSON formatter.
 * 
 * @param test The test that we want to handle.
 * @param testStatesEmitter An emitter for the test suite's state.
 */
function handleStatus(test: any, testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>): void {
  if (test.status === "passed") {
    testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'passed' });
  } else if (test.status === "failed" && test.pending_message === null) {
    let errorMessage: string = test.exception.message;

    // Add backtrace to errorMessage if it exists.
    if (test.exception.backtrace) {
      errorMessage += `\n\nBacktrace:\n`;
      test.exception.backtrace.forEach((line: string) => {
        errorMessage += `${line}\n`;
      });
    }

    testStatesEmitter.fire(<TestEvent>{
      type: 'test',
      test: test.id,
      state: 'failed',
      message: errorMessage
    });
  } else if (test.status === "failed" && test.pending_message !== null) {
    // Handle pending test cases.
    testStatesEmitter.fire(<TestEvent>{ type: 'test', test: test.id, state: 'skipped', message: test.pending_message });
  }
};
