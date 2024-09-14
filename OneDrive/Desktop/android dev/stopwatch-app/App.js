import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';

const App = () => {
    const [time, setTime] = useState(0);
    const [running, setRunning] = useState(false);
    const intervalRef = useRef(null);
    const startTimeRef = useRef(0);

    const startStopwatch = () => {
        startTimeRef.current = Date.now() - time * 1000;
        intervalRef.current = setInterval(() => {
            setTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 1000);
        setRunning(true);
    };

    const pauseStopwatch = () => {
        clearInterval(intervalRef.current);
        setRunning(false);
    };

    const resetStopwatch = () => {
        clearInterval(intervalRef.current);
        setTime(0);
        setRunning(false);
    };

    const resumeStopwatch = () => {
        startTimeRef.current = Date.now() - time * 1000;
        intervalRef.current = setInterval(() => {
            setTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 1000);
        setRunning(true);
    };

    return (
        <View style={styles.container}>
            <View style={styles.watchContainer}>
                <Text style={styles.timeText}>{time}s</Text>
            </View>
            <View style={styles.buttonContainer}>
                {running ? (
                    <TouchableOpacity
                        style={[styles.button, styles.pauseButton]}
                        onPress={pauseStopwatch}
                    >
                        <Text style={styles.buttonText}>Pause</Text>
                    </TouchableOpacity>
                ) : (
                    <>
                        <TouchableOpacity
                            style={[styles.button, styles.startButton]}
                            onPress={startStopwatch}
                        >
                            <Text style={styles.buttonText}>Start</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.button, styles.resetButton]}
                            onPress={resetStopwatch}
                        >
                            <Text style={styles.buttonText}>Reset</Text>
                        </TouchableOpacity>
                    </>
                )}
                {!running && time !== 0 && (
                    <TouchableOpacity
                        style={[styles.button, styles.resumeButton]}
                        onPress={resumeStopwatch}
                    >
                        <Text style={styles.buttonText}>Resume</Text>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};

const { width, height } = Dimensions.get('window');

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F5FCFF',
    },
    watchContainer: {
        width: Math.min(width * 0.8, 300),  // Makes the watch circular and responsive
        height: Math.min(width * 0.8, 300),
        borderRadius: Math.min(width * 0.8, 300) / 2,
        borderWidth: 15,
        borderColor: '#000',
        backgroundColor: '#2c3e50',  // Dark background to highlight the text
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: "#000",
        shadowOffset: {
            width: 0,
            height: 6,
        },
        shadowOpacity: 0.37,
        shadowRadius: 7.49,
        elevation: 12,
    },
    timeText: {
        fontSize: 48,  // Adjusted font size for readability
        fontWeight: 'bold',
        color: '#fff',
    },
    buttonContainer: {
        flexDirection: 'row',
        marginTop: 20,
        justifyContent: 'space-between',
        width: '80%',
    },
    button: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 5,
        elevation: 2,
    },
    startButton: {
        backgroundColor: '#2ecc71',
    },
    resetButton: {
        backgroundColor: '#e74c3c',
    },
    pauseButton: {
        backgroundColor: '#f39c12',
    },
    resumeButton: {
        backgroundColor: '#3498db',
    },
    buttonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: 'bold',
    },
});

export default App;
